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
from ..utils.common import format_api_error, format_model_with_thinking, generate_request_id, log_prepare, log_error, TASK_IMAGE_CAPTION, SOURCE_NODE
from ..services.thinking_control import build_thinking_suppression
from .base import VLMNodeBase


class ImageCaptionNode(VLMNodeBase):
    """
    Image captioning node
    Analyzes input images and generates descriptive prompts
    """

    @classmethod
    def INPUT_TYPES(cls):
        # Get system prompt configuration from config_manager
        from ..config_manager import config_manager
        system_prompts = config_manager.get_system_prompts()

        # Get all vision_prompts as options
        vision_prompts = {}
        if system_prompts and 'vision_prompts' in system_prompts:
            vision_prompts = system_prompts['vision_prompts']

        # Build prompt template options (supports category format: Category/RuleName)
        prompt_template_options = []
        for key, value in vision_prompts.items():
            # Filter out rules not shown in backend
            show_in = value.get('showIn', ["frontend", "node"])
            if 'node' not in show_in:
                continue

            name = value.get('name', key)
            category = value.get('category', '')
            # If categorized, display as "Category/RuleName", otherwise just the rule name
            display_name = f"{category}/{name}" if category else name
            prompt_template_options.append(display_name)

        # If no options available, add a default option
        if not prompt_template_options:
            prompt_template_options = ["Default Image Caption Prompt"]

        # ---Dynamically get VLM service/model list---
        service_options = cls.get_vlm_service_options()
        default_service = service_options[0] if service_options else "Default"

        return {
            "required": {
                "image": ("IMAGE",),
                "rule": (prompt_template_options, {"default": prompt_template_options[0] if prompt_template_options else "Default Image Caption Prompt", "tooltip": "Choose a preset rule for image captioning"}),
                "custom_rule": ("BOOLEAN", {"default": False, "label_on": "Enable", "label_off": "Disable", "tooltip": "Enable to use custom rule content below"}),
                "custom_rule_content": ("STRING", {"multiline": True, "default": "", "placeholder": "Enter custom rule here, only effective when 'Custom Rule' is enabled", "tooltip": "Enter your custom rule content here; type trigger [R] to force re-execution every time"}),
                "user_prompt": ("STRING", {"multiline": True, "default": "", "placeholder": "Enter additional specific requirements to send along with the rule to the model", "tooltip": "Enter additional specific requirements to send along with the rule to the model; type trigger [R] to force re-execution every time"}),
                "vlm_service": (service_options, {"default": default_service, "tooltip": "Select VLM service and model"}),
                # Ollama Automatic VRAM Unload
                "ollama_auto_unload": ("BOOLEAN", {"default": True, "label_on": "Enable", "label_off": "Disable", "tooltip": "Auto unload Ollama model after generation"}),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            }
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("prompt_output", "prompt_list")
    OUTPUT_IS_LIST = (False, True)
    FUNCTION = "analyze_image"
    CATEGORY = "✨Prompt Assistant"
    OUTPUT_NODE = False
    
    @classmethod
    def IS_CHANGED(cls, image=None, rule=None, custom_rule=None, custom_rule_content=None, user_prompt=None, vlm_service=None, ollama_auto_unload=None, unique_id=None):
        """
        Only trigger re-execution when input content actually changes.
        Uses hash of input parameters as the basis for comparison.
        """
        # Check if forced refresh symbol [R] is present
        if cls._check_is_changed_bypass(rule, custom_rule_content, user_prompt):
            return float("nan")

        # Import image hash utility function
        from ..utils.image import compute_image_hash

        # Compute image hash
        img_hash = compute_image_hash(image)

        # Combine all input hashes
        input_hash = hash((
            img_hash,
            rule,
            bool(custom_rule),
            custom_rule_content,
            user_prompt,
            vlm_service,
            bool(ollama_auto_unload)
        ))

        return input_hash
    
    def _analyze_single_image(self, image_data, prompt_template, rule_name, service_id, service, provider_config, unique_id, frame_index=None):
        """
        Analyze a single image (internal method)

        Args:
            image_data: Base64-encoded image data
            prompt_template: Prompt template
            rule_name: Rule name
            service_id: Service ID
            service: Service configuration
            provider_config: Provider configuration
            unique_id: Node unique ID
            frame_index: Frame index in the batch (used for log identification)

        Returns:
            str: Image description result
        """
        # Create request ID (including frame index info)
        frame_suffix = f"_f{frame_index}" if frame_index is not None else ""
        request_id = generate_request_id("icap", None, unique_id) + frame_suffix
        
        # Check whether to disable chain-of-thought
        model_full_name = provider_config.get('model')
        disable_thinking_enabled = service.get('disable_thinking', True)
        thinking_extra = build_thinking_suppression(service_id, model_full_name) if disable_thinking_enabled else None
        model_display = format_model_with_thinking(model_full_name, bool(thinking_extra))

        # Get service display name
        service_display_name = service.get('name', service_id)

        # Preparation phase log (including frame info)
        frame_info = f" [Frame {frame_index + 1}]" if frame_index is not None else ""
        log_prepare(TASK_IMAGE_CAPTION, request_id, SOURCE_NODE, service_display_name, model_display, rule_name + frame_info)

        # Execute image analysis
        result = self._run_vision_task(
            VisionService.analyze_image,
            service_id,
            image_data=image_data,
            request_id=request_id,
            stream_callback=None,
            prompt_content=prompt_template,
            custom_provider=service_id,
            custom_provider_config=provider_config,
            task_type=TASK_IMAGE_CAPTION,
            source=SOURCE_NODE
        )

        if result and result.get('success'):
            description = result.get('data', {}).get('description', '').strip()
            if not description:
                error_msg = 'API returned empty result, please check API key, model configuration, or network connection'
                log_error(TASK_IMAGE_CAPTION, request_id, error_msg, source=SOURCE_NODE)
                raise RuntimeError(f"Analysis failed: {error_msg}")
            return description
        else:
            error_msg = result.get('error', 'Analysis failed, unknown error') if result else 'Analysis service returned no result'
            if error_msg == "Task interrupted":
                raise InterruptProcessingException()
            log_error(TASK_IMAGE_CAPTION, request_id, error_msg, source=SOURCE_NODE)
            raise RuntimeError(f"Analysis failed: {error_msg}")

    def analyze_image(self, image, rule, custom_rule, custom_rule_content, user_prompt, vlm_service, ollama_auto_unload, unique_id=None):
        """
        Analyze image and generate prompts (supports batch traversal)

        Args:
            image: Input image data, supports single or batch
            rule: Selected prompt template
            custom_rule: Whether to enable custom rule
            custom_rule_content: Custom rule content
            user_prompt: User supplementary prompt
            vlm_service: Selected vision service
            ollama_auto_unload: Ollama auto unload toggle
            unique_id: Node unique ID

        Returns:
            tuple: Analysis result; batch input results are separated by newlines
        """
        request_id = None  # Initialize for exception handling

        try:
            # Check input
            if image is None:
                raise ValueError("Input image cannot be empty")

            # ---Prepare prompt template---
            prompt_template = None
            rule_name = "Custom Rule" if (custom_rule and custom_rule_content) else rule
            
            if custom_rule and custom_rule_content:
                prompt_template = custom_rule_content
            else:
                from ..config_manager import config_manager
                system_prompts = config_manager.get_system_prompts()

                vision_prompts = {}
                if system_prompts and 'vision_prompts' in system_prompts:
                    vision_prompts = system_prompts['vision_prompts']

                # Match by display name
                template_found = False
                for key, value in vision_prompts.items():
                    name = value.get('name', key)
                    category = value.get('category', '')
                    display_name = f"{category}/{name}" if category else name
                    if display_name == rule:
                        prompt_template = value.get('content')
                        template_found = True
                        break

                if not template_found:
                    # Backward compatible with old format
                    for key, value in vision_prompts.items():
                        if value.get('name') == rule or key == rule:
                            prompt_template = value.get('content')
                            template_found = True
                            break

                if not template_found or not prompt_template:
                    prompt_template = "Please describe this image in detail, including the subject, scene, style, color, and other elements."
                    rule_name = "Default Rule"

            # Append user prompt
            if user_prompt and user_prompt.strip():
                prompt_template = f"{prompt_template}\n\nUser supplementary requirements:\n{user_prompt}"

            # ---Parse service configuration---
            service_id, model_name = self.parse_service_model(vlm_service)
            if not service_id:
                raise ValueError(f"Invalid service selection: {vlm_service}")
            
            from ..config_manager import config_manager
            service = config_manager.get_service(service_id)
            if not service:
                raise ValueError(f"Service config not found: {vlm_service}")
            
            # Build provider_config
            vlm_models = service.get('vlm_models', [])
            target_model = None
            
            if model_name:
                target_model = next((m for m in vlm_models if m.get('name') == model_name), None)
            
            if not target_model:
                target_model = next((m for m in vlm_models if m.get('is_default')), 
                                    vlm_models[0] if vlm_models else None)
            
            if not target_model:
                raise ValueError(f"Service {vlm_service} has no available models")
            
            provider_config = {
                'provider': service_id,
                'model': target_model.get('name', ''),
                'base_url': service.get('base_url', ''),
                'api_key': service.get('api_key', ''),
                'temperature': target_model.get('temperature', 0.7),
                'max_tokens': target_model.get('max_tokens', 500),
                'top_p': target_model.get('top_p', 0.9),
            }
            
            if service.get('type') == 'ollama':
                provider_config['auto_unload'] = ollama_auto_unload

            # ---Process batch input---
            # Check if 4D tensor (batch format)
            if len(image.shape) == 4 and image.shape[0] > 1:
                # Batch mode: process frame by frame
                batch_size = image.shape[0]
                results = []
                
                for i in range(batch_size):
                    # Extract single frame and convert to base64
                    single_frame = image[i:i+1]  # Keep 4D shape [1, H, W, C]
                    image_data = self._image_to_base64(single_frame)
                    
                    # Analyze single image
                    description = self._analyze_single_image(
                        image_data=image_data,
                        prompt_template=prompt_template,
                        rule_name=rule_name,
                        service_id=service_id,
                        service=service,
                        provider_config=provider_config,
                        unique_id=unique_id,
                        frame_index=i
                    )
                    results.append(description)
                
                # Output: merged result + list
                combined_result = "\n---\n".join(results)
                return (combined_result, results)
            else:
                # Single image mode
                image_data = self._image_to_base64(image)
                description = self._analyze_single_image(
                    image_data=image_data,
                    prompt_template=prompt_template,
                    rule_name=rule_name,
                    service_id=service_id,
                    service=service,
                    provider_config=provider_config,
                    unique_id=unique_id,
                    frame_index=None
                )
                return (description, [description])

        except InterruptProcessingException:
            raise
        except Exception as e:
            error_msg = format_api_error(e, vlm_service)
            if request_id:
                log_error(TASK_IMAGE_CAPTION, request_id, error_msg, source=SOURCE_NODE)
            raise RuntimeError(f"Analysis error: {error_msg}")


# Node class mappings for registering nodes with ComfyUI
NODE_CLASS_MAPPINGS = {
    "ImageCaptionNode": ImageCaptionNode,
}

# Node display name mappings
NODE_DISPLAY_NAME_MAPPINGS = {
    "ImageCaptionNode": "✨Image Caption",
} 