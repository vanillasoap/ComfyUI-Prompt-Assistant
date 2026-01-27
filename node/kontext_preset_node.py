import asyncio
import random
import time
import threading
import hashlib
import base64
from io import BytesIO
import os
import json

import torch
import numpy as np
from PIL import Image
from comfy.model_management import InterruptProcessingException

from ..services.vlm import VisionService
from ..utils.common import format_api_error, log_prepare, log_error, SOURCE_NODE, generate_request_id
from .base import VLMNodeBase


class KontextPresetNode(VLMNodeBase):
    """
    Kontext preset assistant node
    Uses Kontext presets to analyze images and generate creative transformation instructions
    """

    # Cache configuration data to avoid repeated reads from file system
    _kontext_config = None

    @classmethod
    def _load_kontext_config(cls):
        """Load Kontext configuration, using cache to avoid repeated file reads"""
        if cls._kontext_config is None:
            try:
                from ..config_manager import config_manager
                # Use config_manager's kontext_presets_path (points to rules directory)
                kontext_presets_path = config_manager.kontext_presets_path
                
                if os.path.exists(kontext_presets_path):
                    with open(kontext_presets_path, "r", encoding="utf-8") as f:
                        cls._kontext_config = json.load(f)
                else:
                    cls._kontext_config = {}
            except Exception as e:
                print(f"{cls.LOG_PREFIX} Failed to load Kontext configuration: {str(e)}")
                cls._kontext_config = {}
        return cls._kontext_config

    
    @classmethod
    def INPUT_TYPES(cls):
        # Get kontext_presets
        kontext_presets = {}
        config_data = cls._load_kontext_config()
        if 'kontext_presets' in config_data:
            kontext_presets = config_data['kontext_presets']

        # Build prompt template options
        prompt_template_options = []
        for key, value in kontext_presets.items():
            name = value.get('name', key)
            prompt_template_options.append(name)

        # If no options available, add a default option
        if not prompt_template_options:
            prompt_template_options = ["Deep Context Fusion"]

        # ---Dynamically get VLM service/model list---
        service_options = cls.get_vlm_service_options()
        default_service = service_options[0] if service_options else "Default"

        return {
            "required": {
                "image": ("IMAGE",),
                "kontext_preset": (prompt_template_options, {"default": prompt_template_options[0] if prompt_template_options else "Deep Context Fusion"}),
                "user_prompt": ("STRING", {"multiline": True, "default": "", "placeholder": "Enter additional specific requirements to send along with the preset to the model", "tooltip": "Enter additional specific requirements to send along with the preset to the model; type trigger [R] to force re-execution every time"}),
                "vlm_service": (service_options, {"default": default_service, "tooltip": "Select VLM service and model"}),
                # Ollama Automatic VRAM Unload
                "ollama_auto_unload": ("BOOLEAN", {"default": True, "label_on": "Enable", "label_off": "Disable", "tooltip": "Auto unload Ollama model after generation"}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("creative_instruction",)
    FUNCTION = "analyze_image"
    CATEGORY = "✨Prompt Assistant"
    OUTPUT_NODE = False
    
    @classmethod
    def IS_CHANGED(cls, image=None, kontext_preset=None, user_prompt=None, vlm_service=None, ollama_auto_unload=None):
        """
        Only trigger re-execution when input content actually changes.
        Uses hash of input parameters as the basis for comparison.
        """
        # Check if forced refresh symbol [R] is present
        if cls._check_is_changed_bypass(kontext_preset, user_prompt):
            return float("nan")

        # Import image hash utility function
        from ..utils.image import compute_image_hash

        # Compute image hash
        img_hash = compute_image_hash(image)

        # Combine all input hashes
        input_hash = hash((
            img_hash,
            kontext_preset,
            user_prompt,
            vlm_service,
            bool(ollama_auto_unload)
        ))

        return input_hash
    
    def analyze_image(self, image, kontext_preset, user_prompt, vlm_service, ollama_auto_unload):
        """
        Analyze images using Kontext presets and generate creative transformation instructions

        Args:
            image: Input image data
            kontext_preset: Selected Kontext preset
            user_prompt: User supplementary prompt
            vlm_service: Selected vision service

        Returns:
            tuple: Analysis result
        """
        try:
            # Check input
            if image is None:
                raise ValueError("Input image cannot be empty")

            # Convert image to base64 encoding
            image_data = self._image_to_base64(image)

            # Get kontext configuration
            config_data = self.__class__._load_kontext_config()
            kontext_prefix = config_data.get('kontext_prefix', "")
            kontext_suffix = config_data.get('kontext_suffix', "")
            kontext_presets = config_data.get('kontext_presets', {})

            # Get prompt template content
            prompt_template = None

            # Find the selected prompt template
            preset_name = kontext_preset
            template_found = False
            for key, value in kontext_presets.items():
                if value.get('name') == kontext_preset:
                    prompt_template = value.get('content')
                    template_found = True
                    break

            if not template_found:
                # Try to match key name directly
                for key, value in kontext_presets.items():
                    if key == kontext_preset or key == f"kontext_{kontext_preset}":
                        prompt_template = value.get('content')
                        template_found = True
                        break

            # If prompt template not found, use default value
            if not prompt_template:
                prompt_template = "Transform the image into a detailed pencil sketch with fine lines and careful shading."
                preset_name = "Default Preset"

            # Build final prompt, add prefix and suffix
            final_prompt = prompt_template
            if kontext_prefix and kontext_suffix:
                final_prompt = f"{kontext_prefix}\n\nThe Brief: {prompt_template}\n\n{kontext_suffix}"

            # Append user prompt
            if user_prompt and user_prompt.strip():
                final_prompt = f"{final_prompt}\n\nUser supplementary requirements:\n{user_prompt}"

            # ---Parse service/model string---
            service_id, model_name = self.parse_service_model(vlm_service)
            if not service_id:
                raise ValueError(f"Invalid service selection: {vlm_service}")

            # ---Get service configuration---
            from ..config_manager import config_manager
            service = config_manager.get_service(service_id)
            if not service:
                raise ValueError(f"Service config not found: {vlm_service}")

            # ---Build provider_config---
            # Find the specified model or default model
            vlm_models = service.get('vlm_models', [])
            target_model = None

            if model_name:
                # Find the specified model
                target_model = next((m for m in vlm_models if m.get('name') == model_name), None)

            if not target_model:
                # Use default model or first model
                target_model = next((m for m in vlm_models if m.get('is_default')),
                                    vlm_models[0] if vlm_models else None)

            if not target_model:
                raise ValueError(f"Service {vlm_service} has no available models")

            # Build configuration object
            provider_config = {
                'provider': service_id,
                'model': target_model.get('name', ''),
                'base_url': service.get('base_url', ''),
                'api_key': service.get('api_key', ''),
                'temperature': target_model.get('temperature', 0.7),
                'max_tokens': target_model.get('max_tokens', 500),
                'top_p': target_model.get('top_p', 0.9),
            }

            # Ollama special handling: add auto_unload configuration
            if service.get('type') == 'ollama':
                provider_config['auto_unload'] = ollama_auto_unload

            # Create request ID
            request_id = f"kontext_preset_{int(time.time())}_{random.randint(1000, 9999)}"

            # Get service display name
            service_display_name = service.get('name', service_id)

            # Preparation phase log
            log_prepare("Kontext Preset", request_id, SOURCE_NODE, service_display_name, provider_config.get('model'), preset_name)

            # Execute image analysis
            result = self._run_vision_task(
                VisionService.analyze_image,
                service_id,
                image_data=image_data,
                request_id=request_id,
                stream_callback=None,
                prompt_content=final_prompt,
                custom_provider=service_id,
                custom_provider_config=provider_config,
                task_type="Kontext Preset",
                source=SOURCE_NODE
            )

            if result and result.get('success'):
                description = result.get('data', {}).get('description', '').strip()
                if not description:
                    error_msg = 'API returned empty result'
                    log_error("Kontext Preset", request_id, error_msg, source=SOURCE_NODE)
                    raise RuntimeError(f"Analysis failed: {error_msg}")

                # Service layer already printed completion log, no need to repeat here
                return (description,)
            else:
                error_msg = result.get('error', 'Unknown error') if result else 'No result returned'
                # If interrupted error, directly print log and throw InterruptProcessingException
                if error_msg == "Task interrupted":
                    print(f"{self.LOG_PREFIX} ⛔️Task cancelled by user | RequestID:{request_id}")
                    raise InterruptProcessingException()
                log_error("Kontext Preset", request_id, error_msg, source=SOURCE_NODE)
                raise RuntimeError(f"Analysis failed: {error_msg}")

        except InterruptProcessingException:
            print(f"{self.LOG_PREFIX} ⛔️Task cancelled by user | RequestID:{request_id}")
            raise
        except Exception as e:
            error_msg = format_api_error(e, vlm_service)
            log_error("Kontext Preset", request_id, error_msg, source=SOURCE_NODE)
            raise RuntimeError(f"Analysis error: {error_msg}")


# Node class mappings for registering nodes with ComfyUI
NODE_CLASS_MAPPINGS = {
    "KontextPresetNode": KontextPresetNode,
}

# Node display name mappings
NODE_DISPLAY_NAME_MAPPINGS = {
    "KontextPresetNode": "✨Kontext Preset",
} 