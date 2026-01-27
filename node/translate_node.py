import asyncio
import random
import re
import time
import threading
import hashlib

import torch
from comfy.model_management import InterruptProcessingException

from ..services.llm import LLMService
from ..services.baidu import BaiduTranslateService
from ..utils.common import format_api_error, format_model_with_thinking, generate_request_id, log_prepare, log_error, TASK_TRANSLATE, SOURCE_NODE
from ..services.thinking_control import build_thinking_suppression
from .base import LLMNodeBase


class PromptTranslate(LLMNodeBase):
    """
    Prompt translation node
    Automatically detects input language and translates to the target language, supporting multiple translation services
    """

    @classmethod
    def INPUT_TYPES(cls):
        # ---Dynamically get translation service/model list (including hardcoded Baidu Translate)---
        service_options = cls.get_translate_service_options()
        default_service = service_options[0] if service_options else "Baidu Translate"
        
        return {
            "required": {
                "source_text": ("STRING", {"forceInput": True, "default": "", "multiline": True, "placeholder": "Input text to translate...", "tooltip": "Text to translate; type trigger [R] to force re-execution every time"}),
                "target_language": (["English", "Chinese"], {"default": "English"}),
                "translate_service": (service_options, {"default": default_service, "tooltip": "Select translation service and model"}),
                # Ollama Automatic VRAM Unload
                "ollama_auto_unload": ("BOOLEAN", {"default": True, "label_on": "Enable", "label_off": "Disable", "tooltip": "Auto unload Ollama model after generation"}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("translated_text",)
    FUNCTION = "translate"
    CATEGORY = "✨Prompt Assistant"
    OUTPUT_NODE = False
    
    @classmethod
    def IS_CHANGED(cls, source_text=None, target_language=None, translate_service=None, ollama_auto_unload=None, unique_id=None):
        """
        Only trigger re-execution when input content actually changes.
        Uses hash of input parameters as the basis for comparison.
        """
        # Check if forced refresh symbol [R] is present
        if cls._check_is_changed_bypass(source_text):
            return float("nan")

        # Compute text hash
        text_hash = ""
        if source_text:
            # Use hashlib to compute text hash for better security and consistency
            text_hash = hashlib.md5(source_text.encode('utf-8')).hexdigest()

        # Combine all input hashes
        input_hash = hash((
            text_hash,
            target_language,
            translate_service,
            bool(ollama_auto_unload)
        ))

        return input_hash

    def _contains_chinese(self, text: str) -> bool:
        """Check if text contains Chinese characters"""
        if not text:
            return False
        return bool(re.search('[\u4e00-\u9fa5]', text))

    def _detect_language(self, text: str) -> str:
        """Automatically detect text language"""
        if not text:
            return "auto"

        # Check if pure English (only ASCII printable characters)
        is_pure_english = bool(re.fullmatch(r'[ -~]+', text))
        # Check if contains Chinese characters
        contains_chinese = self._contains_chinese(text)

        if contains_chinese:
            return "zh"
        elif is_pure_english:
            return "en"
        else:
            return "auto"
    
    def translate(self, source_text, target_language, translate_service, ollama_auto_unload, unique_id=None):
        """
        Translate text function
        """
        request_id = None  # Elevate to method-level scope
        try:
            # Check input
            if not source_text or not source_text.strip():
                return ("",)

            # Automatically detect source language
            detected_lang = self._detect_language(source_text)
            to_lang = "en" if target_language == "English" else "zh"

            # Smart skip translation logic
            skip_translation = False
            if to_lang == 'en' and detected_lang == 'en':
                from ..utils.common import _ANSI_CLEAR_EOL
                print(f"\r{_ANSI_CLEAR_EOL}{self.REQUEST_PREFIX} English input detected, target is English, skipping translation", flush=True)
                skip_translation = True
            elif to_lang == 'zh' and detected_lang == 'zh':
                from ..utils.common import _ANSI_CLEAR_EOL
                print(f"\r{_ANSI_CLEAR_EOL}{self.REQUEST_PREFIX} Chinese input detected, target is Chinese, skipping translation", flush=True)
                skip_translation = True

            if skip_translation:
                return (source_text,)

            # Map language names
            lang_map = {'zh': 'Chinese', 'en': 'English', 'auto': 'Original'}
            from_lang_name = lang_map.get(detected_lang, detected_lang)
            to_lang_name = lang_map.get(to_lang, to_lang)
            
            # ---Parse service/model string---
            service_id, model_name = self.parse_service_model(translate_service)
            if not service_id:
                raise ValueError(f"Invalid service selection: {translate_service}")
            
            # ---Baidu Translate special handling---
            if service_id == 'baidu':
                request_id, result = self._translate_with_baidu(source_text, detected_lang, to_lang, translate_service, from_lang_name, to_lang_name, unique_id)
            else:
                # ---LLM translation: get service configuration---
                from ..config_manager import config_manager
                service = config_manager.get_service(service_id)
                if not service:
                    raise ValueError(f"Service config not found: {translate_service}")
                
                request_id, result = self._translate_with_llm(source_text, detected_lang, to_lang, service_id, model_name, service, translate_service, from_lang_name, to_lang_name, ollama_auto_unload, unique_id)

            if result and result.get('success'):
                translated_text = result.get('data', {}).get('translated', '').strip()
                if not translated_text:
                    error_msg = 'API returned empty result'
                    raise RuntimeError(f"❌Translation failed: {error_msg}")

                # Result phase log is handled by the service layer; node layer does not print again
                return (translated_text,)
            else:
                error_msg = result.get('error', 'Unknown error') if result else 'No result returned'
                # If interrupted, throw InterruptProcessingException directly without logging (handled by base class)
                if error_msg == "Task interrupted":
                    raise InterruptProcessingException()
                log_error(TASK_TRANSLATE, request_id, error_msg)
                raise RuntimeError(f"Translation failed: {error_msg}")

        except InterruptProcessingException:
            # Do not print log; handled uniformly by base class
            raise
        except Exception as e:
            error_msg = format_api_error(e, translate_service)
            log_error(TASK_TRANSLATE, request_id, error_msg)
            raise RuntimeError(f"Translation error: {error_msg}")

    def _translate_with_baidu(self, text, from_lang, to_lang, service_name, from_lang_name, to_lang_name, unique_id):
        """Use Baidu Translate service"""
        # Create request ID
        request_id = generate_request_id("trans", "baidu", unique_id)

        # Preparation phase log
        log_prepare(TASK_TRANSLATE, request_id, SOURCE_NODE, "Baidu Translate", None, None, {"direction": f"{from_lang_name}→{to_lang_name}", "length": len(text)})

        # Execute translation (async thread + interruptible)
        result = self._run_llm_task(
            BaiduTranslateService.translate,
            service_name,
            text=text,
            from_lang=from_lang,
            to_lang=to_lang,
            request_id=request_id,
            task_type=TASK_TRANSLATE,
            source=SOURCE_NODE
        )

        return request_id, result

    def _translate_with_llm(self, text, from_lang, to_lang, service_id, model_name, service, service_display_name, from_lang_name, to_lang_name, auto_unload, unique_id):
        """Use LLM translation service"""
        # ---Build provider_config---
        # Find the specified model or default model
        llm_models = service.get('llm_models', [])
        target_model = None
        
        if model_name:
            # Find the specified model
            target_model = next((m for m in llm_models if m.get('name') == model_name), None)

        if not target_model:
            # Use default model or first model
            target_model = next((m for m in llm_models if m.get('is_default')), 
                                llm_models[0] if llm_models else None)
        
        if not target_model:
            return {"success": False, "error": f"Service {service_display_name} has no available models"}
        
        # Build configuration object
        provider_config = {
            'provider': service_id,
            'model': target_model.get('name', ''),
            'base_url': service.get('base_url', ''),
            'api_key': service.get('api_key', ''),
            'temperature': target_model.get('temperature', 0.7),
            'max_tokens': target_model.get('max_tokens', 1000),
            'top_p': target_model.get('top_p', 0.9),
        }
        
        # Ollama special handling: add auto_unload configuration
        if service.get('type') == 'ollama':
            provider_config['auto_unload'] = auto_unload

        # Create request ID
        request_id = generate_request_id("trans", "llm", unique_id)

        # Check whether to disable chain-of-thought
        model_full_name = provider_config.get('model')
        disable_thinking_enabled = service.get('disable_thinking', True)
        thinking_extra = build_thinking_suppression(service_id, model_full_name) if disable_thinking_enabled else None
        model_display = format_model_with_thinking(model_full_name, bool(thinking_extra))
        
        # Get service display name
        service_display_name = service.get('name', service_id)

        # Preparation phase log
        log_prepare(TASK_TRANSLATE, request_id, SOURCE_NODE, service_display_name, model_display, None, {"direction": f"{from_lang_name}→{to_lang_name}", "length": len(text)})

        # Check API key and model
        api_key = provider_config.get('api_key', '')
        model = provider_config.get('model', '')
        
        if not api_key or not model:
            return {"success": False, "error": f"Please configure API key and model for {service_display_name}"}

        # Execute translation (async thread + interruptible)
        result = self._run_llm_task(
            LLMService.translate,
            service_id,
            text=text,
            from_lang=from_lang,
            to_lang=to_lang,
            request_id=request_id,
            stream_callback=None,
            custom_provider=service_id,
            custom_provider_config=provider_config,
            task_type=TASK_TRANSLATE,
            source=SOURCE_NODE
        )

        return request_id, result


# Node class mappings for registering nodes with ComfyUI
NODE_CLASS_MAPPINGS = {
    "PromptTranslate": PromptTranslate,
}

# Node display name mappings
NODE_DISPLAY_NAME_MAPPINGS = {
    "PromptTranslate": "✨Prompt Translate",
}
