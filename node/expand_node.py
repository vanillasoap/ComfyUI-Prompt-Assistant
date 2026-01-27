import asyncio
import random
import time
import threading
import hashlib
import re

from comfy.model_management import InterruptProcessingException

from ..services.llm import LLMService
from ..utils.common import format_api_error, format_model_with_thinking, generate_request_id, log_prepare, log_error, TASK_EXPAND, SOURCE_NODE
from ..services.thinking_control import build_thinking_suppression
from .base import LLMNodeBase


class PromptExpand(LLMNodeBase):
    """
    Prompt enhancement node
    - Takes "source_text" input and enhances/expands it based on the selected rule template or custom rule
    - Contains a single string input and a single string output
    """

    @classmethod
    def INPUT_TYPES(cls):
        # Get system prompt configuration from config_manager
        from ..config_manager import config_manager
        system_prompts = config_manager.get_system_prompts()

        # Get all expand_prompts as dropdown options
        expand_prompts = {}
        active_expand_id = None
        if system_prompts:
            expand_prompts = system_prompts.get('expand_prompts', {}) or {}
            active_expand_id = system_prompts.get('active_prompts', {}).get('expand')

        # Build prompt template options (supports category format: Category/RuleName)
        prompt_template_options = []
        id_to_display_name = {}
        for key, value in expand_prompts.items():
            # Filter out rules not shown in backend
            show_in = value.get('showIn', ["frontend", "node"])
            if 'node' not in show_in:
                continue

            name = value.get('name', key)
            category = value.get('category', '')
            # If categorized, display as "Category/RuleName", otherwise just the rule name
            display_name = f"{category}/{name}" if category else name
            id_to_display_name[key] = display_name
            prompt_template_options.append(display_name)

        # Default option fallback
        default_template_name = prompt_template_options[0] if prompt_template_options else "Expand-Natural Language"
        if active_expand_id and active_expand_id in id_to_display_name:
            default_template_name = id_to_display_name[active_expand_id]

        # ---Dynamically get LLM service/model list---
        service_options = cls.get_llm_service_options()
        default_service = service_options[0] if service_options else "Default"

        return {
            "required": {
                # Rule template: all expansion rules from system configuration
                "rule": (prompt_template_options or ["Expand-Natural Language"], {"default": default_template_name, "tooltip": "Choose a preset rule for prompt enhancement"}),
                # Custom rule toggle
                "custom_rule": ("BOOLEAN", {"default": False, "label_on": "Enable", "label_off": "Disable", "tooltip": "Enable to use custom rule content below instead of preset"}),
                # Custom rule content input
                "custom_rule_content": ("STRING", {"multiline": True, "default": "", "placeholder": "Enter custom rule here, only effective when 'Custom Rule' is enabled", "tooltip": "Enter your custom rule content here; type trigger [R] to force re-execution every time"}),
                # User prompt
                "user_prompt": ("STRING", {"multiline": True, "default": "", "placeholder": "Enter the original prompt to enhance; if both port input and content input exist, they will be merged", "tooltip": "Original prompt to enhance; type trigger [R] to force re-execution every time"}),
                # Expansion service
                "llm_service": (service_options, {"default": default_service, "tooltip": "Select LLM service and model"}),
                # Ollama automatic VRAM unload
                "ollama_auto_unload": ("BOOLEAN", {"default": True, "label_on": "Enable", "label_off": "Disable", "tooltip": "Auto unload Ollama model after generation"}),
            },
            "optional": {
                # Source text input port
                "source_text": ("STRING", {"default": "", "multiline": True, "defaultInput": True, "placeholder": "Input text to enhance...", "tooltip": "Optional input text; type trigger [R] to force re-execution every time"}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            }
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("enhanced_text",)
    FUNCTION = "enhance"
    CATEGORY = "✨Prompt Assistant"
    OUTPUT_NODE = False

    @classmethod
    def IS_CHANGED(cls, rule=None, custom_rule=None, custom_rule_content=None, user_prompt=None, llm_service=None, ollama_auto_unload=None, source_text=None, unique_id=None):
        """
        Only trigger re-execution when input content actually changes.
        Uses hash of input parameters as the basis for comparison.
        """
        # Check if forced refresh symbol [R] is present
        if cls._check_is_changed_bypass(rule, custom_rule_content, user_prompt, source_text):
            return float("nan")

        text_hash = hashlib.md5(((source_text or "")).encode('utf-8')).hexdigest()
        temp_rule_hash = hashlib.md5((custom_rule_content or "").encode('utf-8')).hexdigest()
        user_hint_hash = hashlib.md5((user_prompt or "").encode('utf-8')).hexdigest()

        input_hash = hash((
            rule,
            bool(custom_rule),
            temp_rule_hash,
            user_hint_hash,
            llm_service,
            bool(ollama_auto_unload),
            text_hash,
        ))
        return input_hash

    def enhance(self, rule, custom_rule, custom_rule_content, user_prompt, llm_service, ollama_auto_unload, source_text=None, unique_id=None):
        """
        Enhance/expand text function
        """
        try:
            # Allow source text to be empty, but at least one of source text or user prompt must be non-empty
            source_text = (source_text or "").strip()
            user_prompt = (user_prompt or "").strip()
            if not source_text and not user_prompt:
                return ("",)

            # Prepare system prompt (rule)
            system_message = None
            rule_name = "Custom Rule" if (custom_rule and custom_rule_content) else rule

            if custom_rule and custom_rule_content:
                # Use custom rule
                system_message = {"role": "system", "content": custom_rule_content}
            else:
                # Use template: get system prompt configuration from config_manager
                from ..config_manager import config_manager
                system_prompts = config_manager.get_system_prompts()
                expand_prompts = system_prompts.get('expand_prompts', {}) if system_prompts else {}

                # Find the selected prompt template (match by display name)
                # Display name format: "Category/RuleName" when categorized, "RuleName" otherwise
                template_found = False
                for key, value in expand_prompts.items():
                    name = value.get('name', key)
                    category = value.get('category', '')
                    # Build display name consistent with dropdown list
                    display_name = f"{category}/{name}" if category else name
                    if display_name == rule:
                        system_message = {"role": value.get('role', 'system'), "content": value.get('content', '')}
                        template_found = True
                        break
                if not template_found:
                    # Allow matching by rule name or key name directly (backward compatible)
                    for key, value in expand_prompts.items():
                        if value.get('name') == rule or key == rule:
                            system_message = {"role": value.get('role', 'system'), "content": value.get('content', '')}
                            template_found = True
                            break
                if not template_found or not system_message or not system_message.get('content'):
                    # Fallback to default
                    system_message = {"role": "system", "content": "You are a prompt expansion expert. Please expand the user-provided text into a more complete, readable, and actionable prompt."}
                    rule_name = "Default Rule"

            # ---Parse service/model string---
            service_id, model_name = self.parse_service_model(llm_service)
            if not service_id:
                raise ValueError(f"Invalid service selection: {llm_service}")
            
            # ---Get service configuration---
            from ..config_manager import config_manager
            service = config_manager.get_service(service_id)
            if not service:
                raise ValueError(f"Service config not found: {llm_service}")

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
                raise ValueError(f"Service {llm_service} has no available models")
            
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
                provider_config['auto_unload'] = ollama_auto_unload

            # Execute expansion (async thread + interruptible)
            request_id = generate_request_id("exp", None, unique_id)

            # Merge source text and user prompt
            # Merge order: input port (source_text) first, node input (user_prompt) second
            combined_text = user_prompt if not source_text else (f"{source_text}\n\n{user_prompt}" if user_prompt else source_text)
            
            # Check whether to disable chain-of-thought
            model_name = provider_config.get('model')
            disable_thinking_enabled = service.get('disable_thinking', True)
            thinking_extra = build_thinking_suppression(service_id, model_name) if disable_thinking_enabled else None
            model_display = format_model_with_thinking(model_name, bool(thinking_extra))

            # Get service display name
            service_display_name = service.get('name', service_id)

            # Preparation phase log
            log_prepare(TASK_EXPAND, request_id, SOURCE_NODE, service_display_name, model_display, rule_name, {"length": len(combined_text)})

            # Check API key and model
            api_key = provider_config.get('api_key', '')
            model = provider_config.get('model', '')
            
            if not api_key or not model:
                raise ValueError(f"Please configure API key and model for {llm_service}")

            # Execute expansion (async thread + interruptible)
            result = self._run_llm_task(
                LLMService.expand_prompt,
                service_id,
                prompt=combined_text,
                request_id=request_id,
                stream_callback=None,
                custom_provider=service_id,
                custom_provider_config=provider_config,
                system_message_override=system_message,
                task_type=TASK_EXPAND,
                source=SOURCE_NODE
            )

            if result and result.get('success'):
                expanded_text = result.get('data', {}).get('expanded', '').strip()
                if not expanded_text:
                    error_msg = 'API returned empty result'
                    log_error(TASK_EXPAND, request_id, error_msg, source=SOURCE_NODE)
                    raise RuntimeError(f"Enhancement failed: {error_msg}")
                # Result phase log is handled by the service layer; node layer does not print again
                return (expanded_text,)
            else:
                error_msg = result.get('error', 'Unknown error') if result else 'No result returned'
                # If interrupted, throw InterruptProcessingException directly without logging (handled by base class)
                if error_msg == "Task interrupted":
                    raise InterruptProcessingException()
                log_error(TASK_EXPAND, request_id, error_msg, source=SOURCE_NODE)
                raise RuntimeError(f"Enhancement failed: {error_msg}")

        except InterruptProcessingException:
            # Do not print log; handled uniformly by base class
            raise
        except Exception as e:
            error_msg = format_api_error(e, llm_service)
            log_error(TASK_EXPAND, request_id, error_msg, source=SOURCE_NODE)
            raise RuntimeError(f"Enhancement error: {error_msg}")

    # _get_provider_config method is provided by the base class LLMNodeBase



# Node class mappings for registering nodes with ComfyUI
NODE_CLASS_MAPPINGS = {
    "PromptExpand": PromptExpand,
}

# Node display name mappings
NODE_DISPLAY_NAME_MAPPINGS = {
    "PromptExpand": "✨Prompt Enhance",
}
