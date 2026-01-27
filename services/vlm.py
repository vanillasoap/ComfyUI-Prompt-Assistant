"""
VLM Service - Refactored version
Provides image analysis functionality for vision models
Inherits OpenAICompatibleService to reuse common logic
"""

import json
import time
import asyncio
from typing import Optional, Dict, Any, List, Callable
import httpx
from .openai_base import OpenAICompatibleService, filter_thinking_content
from ..utils.common import (
    format_api_error, preprocess_image, check_multi_image_support, ProgressBar,
    log_complete, log_error,
    PREFIX, PROCESS_PREFIX, WARN_PREFIX, ERROR_PREFIX, format_elapsed_time,
    TASK_IMAGE_CAPTION, TASK_VIDEO_CAPTION
)
from .thinking_control import build_thinking_suppression


class VisionService(OpenAICompatibleService):
    """
    Vision model service
    Supports single and multi-image analysis
    """
    
    @staticmethod
    def _get_config() -> Dict[str, Any]:
        """Get vision model configuration"""
        from ..config_manager import config_manager
        config = config_manager.get_vision_config()
        current_provider = config.get('provider')

        if 'providers' in config and current_provider in config['providers']:
            provider_config = config['providers'][current_provider]
            return {
                'provider': current_provider,
                'model': provider_config.get('model', ''),
                'base_url': provider_config.get('base_url', ''),
                'api_key': provider_config.get('api_key', ''),
                'temperature': provider_config.get('temperature', 0.7),
                'top_p': provider_config.get('top_p', 0.9),
                'max_tokens': provider_config.get('max_tokens', 2000),
                'auto_unload': provider_config.get('auto_unload', True)
            }
        else:
            return config
    
    @staticmethod
    async def _call_ollama_native_vision(
        model: str,
        system_prompt: str,
        images_b64: List[str],
        temperature: float,
        top_p: float,
        max_tokens: int,
        base_url: str,
        stream_callback: Optional[Callable[[str], None]] = None,
        request_id: Optional[str] = None,
        is_multi: bool = False,
        auto_unload: bool = True,
        enable_advanced_params: bool = False,
        thinking_extra: Optional[Dict[str, Any]] = None,
        cancel_event: Optional[Any] = None,
        task_type: str = None,
        source: str = None
    ) -> Dict[str, Any]:
        """
        Call Ollama native vision API (/api/chat)
        Supports single and multi-image analysis

        Args:
            enable_advanced_params: Whether to send advanced parameters (temperature/top_p/num_predict)
            thinking_extra: Thinking chain control parameters
        """
        from ..server import is_streaming_progress_enabled
        
        try:
            start_time = time.perf_counter()
            
            _thinking_extra = thinking_extra  # Use the passed-in parameter
            _thinking_tag = "💭" if _thinking_extra else ""
            
            # Calculate base URL (ensure /v1 and trailing slash are removed)
            native_base = base_url.rstrip('/') if base_url else 'http://localhost:11434'
            if native_base.endswith('/v1'):
                native_base = native_base[:-3].rstrip('/')
            
            # Dynamically calculate num_ctx (based on image count)
            # Each image requires approximately 1024-2048 tokens
            img_count = len(images_b64)
            
            # Text token estimation (0.6 coefficient)
            prompt_ctx = int(len(system_prompt) * 0.6)
            
            # Image token estimation (2048 per image as baseline)
            image_ctx = img_count * 2048
            
            # --- Smart reservation strategy (adapted for Vision models) ---
            # Key point: Vision models' thinking process also consumes a large amount of Output Tokens
            
            is_safe_standard_model = False
            if model:
                m = model.lower()
                if "instruct" in m or "chat" in m:
                    is_safe_standard_model = True

            if _thinking_extra or is_safe_standard_model:
                # Thinking chain disabled OR standard instruction model -> maximum savings mode
                min_output = 512
                # Single image can go as low as 2048, multi-image starts at 3072 for stability
                ctx_floor = 2048 if not is_multi else 3072
                sys_buffer = 384
            else:
                # Thinking chain not disabled -> safe mode
                min_output = 1024
                # Single image floor reduced from 4096 to 2048 (adapted for Ollama VRAM allocation optimization)
                ctx_floor = 2048 if not is_multi else 4096
                sys_buffer = 384 if not is_multi else 1024
            
            # Output reservation (multi-image needs more)
            # For single image mode, 512 is sufficient for description; for multi-image, use min_output
            base_reserve = (img_count * 512) if is_multi else 512
            output_reserve = max(512 if not is_multi else min_output, base_reserve)
            
            required_ctx = prompt_ctx + image_ctx + output_reserve + sys_buffer
            
            # Range: [ctx_floor, 65536]
            num_ctx = max(ctx_floor, min(65536, required_ctx))
            num_ctx = ((num_ctx + 1023) // 1024) * 1024
            
            # [Debug] Output multi-image request info
            print(f"{PREFIX} 🐏 Vision request | Images:{len(images_b64)} | num_ctx:{num_ctx} | Model:{model}")
            
            # Build base request body
            payload = {
                "model": model,
                "messages": [{"role": "user", "content": system_prompt, "images": images_b64}],
                "stream": True
            }
            
            # ---Build options---
            # Base parameter: num_ctx (dynamic context window size)
            options = {
                "num_ctx": num_ctx
            }
            
            # Advanced parameters: only sent when user enables them
            # Parameter descriptions (based on Ollama official docs):
            # - temperature: Controls randomness, default 0.8, lower values produce more stable output
            # - top_p: Nucleus sampling, default 0.9, limits candidate word probability range
            # - num_predict: Maximum generated token count, default -1 (unlimited)
            if enable_advanced_params:
                options["temperature"] = temperature
                options["top_p"] = top_p
                options["num_predict"] = max_tokens
            
            payload["options"] = options
            
            # Add thinking chain control parameters (e.g., think: true or think: false)
            if _thinking_extra:
                payload.update(_thinking_extra)
            
            # Set timeout
            # Base read timeout 60s + 30s per image + context length adaptive
            base_read_timeout = 60.0
            per_image_read_timeout = 30.0
            ctx_based_timeout = (num_ctx / 1000) * 2.0 # Add 2 seconds per 1000 tokens
            
            calculated_read_timeout = base_read_timeout + (img_count * per_image_read_timeout) + ctx_based_timeout
            
            # Maximum read timeout capped at 10 minutes (600s)
            final_read_timeout = min(600.0, max(60.0, calculated_read_timeout))
            
            # Create unified progress bar (automatically handles waiting -> generating -> done lifecycle)
            extra_info = f"Context:{num_ctx} | Timeout:{int(final_read_timeout)}s"
            pbar = ProgressBar(
                request_id=request_id,
                service_name="Ollama",
                extra_info=extra_info,
                streaming=is_streaming_progress_enabled(),
                task_type=task_type,
                source=source
            )
            
            start_time = time.perf_counter()
            
            # Get persistent client to support connection reuse
            from .core import HTTPClientPool
            client = HTTPClientPool.get_client(
                provider="Ollama(Vision)",
                base_url=native_base,
                timeout=final_read_timeout
            )
            
            full_content = ""
            
            async def _request_core():
                nonlocal full_content
                async with client.stream('POST', f"{native_base}/api/chat", json=payload, follow_redirects=True) as resp:
                    if resp.status_code != 200:
                        error_text = await resp.aread()
                        pbar.error(f"Ollama API error: {resp.status_code}")
                        try:
                            error_data = json.loads(error_text)
                            return {"success": False, "error": error_data.get('error', f'HTTP {resp.status_code}')}
                        except:
                            return {"success": False, "error": f'HTTP {resp.status_code}'}
                    
                    async for line in resp.aiter_lines():
                        if not line: continue
                        try:
                            chunk_data = json.loads(line)
                            message = chunk_data.get('message')
                            if message and isinstance(message, dict):
                                content = message.get('content', '') or ''
                                if not content.strip():
                                    thinking = message.get('thinking', '') or message.get('reasoning', '')
                                    if thinking and len(thinking.strip()) > 5:
                                        content = thinking
                                
                                if content and content.strip():
                                    full_content += content
                                    pbar.set_generating(len(full_content))
                                    pbar.update(len(full_content))
                                    if stream_callback: stream_callback(content)
                            
                            if chunk_data.get('done', False):
                                pbar.done(char_count=len(full_content), elapsed_ms=int((time.perf_counter() - start_time) * 1000))
                                break
                        except: continue
                return {"success": True, "content": full_content.strip()}

            # Define monitor logic
            async def _monitor_interrupts(target_task):
                while not target_task.done():
                    is_interrupted = False
                    if cancel_event is not None and cancel_event.is_set():
                        is_interrupted = True
                    else:
                        try:
                            from server import PromptServer
                            if hasattr(PromptServer.instance, 'execution_interrupted') and PromptServer.instance.execution_interrupted:
                                is_interrupted = True
                        except: pass
                    
                    if is_interrupted:
                        target_task.cancel()
                        return True
                    await asyncio.sleep(0.1)
                return False

            # Concurrent execution
            req_task = asyncio.create_task(_request_core())
            monitor_task = asyncio.create_task(_monitor_interrupts(req_task))
            
            try:
                result = await req_task
                # Fallback handling: ensure progress bar is stopped on failure
                if not result.get("success") and not getattr(pbar, '_closed', False):
                    pbar.error(result.get("error", "Unknown error"))
                return result
            except Exception as req_err:
                if 'pbar' in locals() and pbar:
                    pbar.error(f"Ollama(Vision) request exception: {req_err}")
                return {"success": False, "error": f"Ollama(Vision) request exception: {req_err}"}
            except asyncio.CancelledError:

                # Critical fix: ensure progress bar is properly cleaned up when monitor cancels
                pbar.cancel(f"{WARN_PREFIX} Task interrupted | Service:Ollama(Vision)")
                return {"success": False, "error": "Task interrupted", "interrupted": True}
            finally:
                if not monitor_task.done(): monitor_task.cancel()
                # VRAM release guarantee: vision nodes are more VRAM-sensitive, must ensure execution on all exit paths
                try:
                    from .llm import LLMService
                    await LLMService._unload_ollama_model(model, {"base_url": native_base, "auto_unload": auto_unload})
                except: pass
        
        # Critical fix: separately catch outer CancelledError, ensure pbar is properly stopped
        except asyncio.CancelledError:
            if 'pbar' in locals() and pbar:
                pbar.cancel(f"{WARN_PREFIX} Task externally cancelled | Service:Ollama(Vision)")
            return {"success": False, "error": "Task cancelled", "interrupted": True}

        except Exception as e:
            # Critical fix: ensure pbar is also stopped on exception
            if 'pbar' in locals() and pbar:
                pbar.error(format_api_error(e, "Ollama"))
            return {"success": False, "error": format_api_error(e, "Ollama")}
    
    @staticmethod
    async def analyze_image(
        image_data: str,
        request_id: Optional[str] = None,
        stream_callback: Optional[Callable[[str], None]] = None,
        prompt_content: Optional[str] = None,
        custom_provider: Optional[str] = None,
        custom_provider_config: Optional[Dict[str, Any]] = None,
        cancel_event: Optional[Any] = None,
        task_type: str = None,
        source: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Analyze a single image using a vision model

        Args:
            image_data: Image data (Base64 encoded)
            request_id: Request ID
            stream_callback: Streaming output callback
            prompt_content: Custom prompt
            custom_provider: Custom provider
            custom_provider_config: Custom configuration

        Returns:
            Dict: {"success": bool, "data": {"description": str}, "error": str}
        """
        try:
            # Get configuration
            if custom_provider and custom_provider_config:
                provider = custom_provider
                api_key = custom_provider_config.get('api_key')
                model = custom_provider_config.get('model')
                temperature = custom_provider_config.get('temperature', 0.7)
                top_p = custom_provider_config.get('top_p', 0.9)
                max_tokens = custom_provider_config.get('max_tokens', 2000)
                base_url = custom_provider_config.get('base_url', '')
            else:
                config = VisionService._get_config()
                provider = config.get('provider', 'unknown')
                api_key = config.get('api_key')
                model = config.get('model')
                temperature = config.get('temperature', 0.7)
                top_p = config.get('top_p', 0.9)
                max_tokens = config.get('max_tokens', 2000)
                base_url = config.get('base_url', '')

            # Note: Allow empty API Key, supporting unauthenticated providers
            if not model:
                return {"success": False, "error": "Model name not configured"}

            provider_display_name = VisionService.get_provider_display_name(provider)

            from ..utils.common import REQUEST_PREFIX, PREFIX, format_model_with_thinking

            # Check service configuration to determine whether to show thinking chain indicator
            from ..config_manager import config_manager
            service = config_manager.get_service(provider)
            disable_thinking_enabled = service.get('disable_thinking', True) if service else True
            # Only show indicator when the toggle is enabled and the model supports it
            _thinking_check = build_thinking_suppression(provider, model) if disable_thinking_enabled else None
            thinking_disabled = _thinking_check is not None
            model_display = format_model_with_thinking(model, thinking_disabled)

            # Preprocess image
            processed_image = preprocess_image(image_data, request_id=request_id)

            # Get system prompt
            system_prompt = prompt_content or "Please describe this image in detail, including main objects, scene, colors, atmosphere, etc."

            # Ollama uses native API (determined by service type)
            if service and service.get('type') == 'ollama':
                # Read Ollama service configuration
                enable_advanced_params = service.get('enable_advanced_params', False)
                filter_thinking_output = service.get('filter_thinking_output', True)
                _ollama_thinking_extra = build_thinking_suppression(provider, model) if disable_thinking_enabled else None

                # Extract pure base64
                b64 = processed_image.split(',')[1] if ',' in processed_image else processed_image

                # Pre-calculate auto_unload configuration
                native_base = base_url[:-3] if base_url.endswith('/v1') else (base_url or 'http://localhost:11434')
                native_base = native_base.rstrip('/')
                _cfg = {
                    'auto_unload': custom_provider_config.get('auto_unload', True) if custom_provider_config else config.get('auto_unload', True),
                    'base_url': native_base
                }
                auto_unload = _cfg['auto_unload']

                result = await VisionService._call_ollama_native_vision(
                    model=model,
                    system_prompt=system_prompt,
                    images_b64=[b64],
                    temperature=temperature,
                    top_p=top_p,
                    max_tokens=max_tokens,
                    base_url=base_url,
                    stream_callback=stream_callback,
                    request_id=request_id,
                    is_multi=False,
                    auto_unload=auto_unload,
                    enable_advanced_params=enable_advanced_params,
                    thinking_extra=_ollama_thinking_extra,
                    cancel_event=cancel_event,
                    task_type=task_type or TASK_IMAGE_CAPTION,
                    source=source
                )
                
                if result["success"]:
                    # Note: Unloading is handled in _call_ollama_native_vision's finally block

                    # Apply thinking chain output filtering
                    content = result["content"]
                    if filter_thinking_output:
                        content = filter_thinking_content(content)

                    return {
                        "success": True,
                        "data": {"description": content}
                    }
                else:
                    return result

            # Other services use direct HTTP connection
            if not base_url:
                base_url = VisionService.get_provider_base_url(provider, custom_provider_config if custom_provider else None)

            # Build message (image format)
            messages = [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": system_prompt},
                        {"type": "image_url", "image_url": {"url": processed_image}}
                    ]
                }
            ]
            
            # Check disable_thinking, enable_advanced_params and filter_thinking_output configuration
            from ..config_manager import config_manager
            service = config_manager.get_service(provider)
            disable_thinking_enabled = service.get('disable_thinking', True) if service else True
            enable_advanced_params = service.get('enable_advanced_params', False) if service else False
            filter_thinking_output = service.get('filter_thinking_output', True) if service else True
            thinking_extra = build_thinking_suppression(provider, model) if disable_thinking_enabled else None

            result = await VisionService._http_request_chat_completions(
                base_url=base_url,
                api_key=api_key,
                model=model,
                messages=messages,
                temperature=temperature,
                top_p=top_p,
                max_tokens=max_tokens,
                thinking_extra=thinking_extra,
                enable_advanced_params=enable_advanced_params,
                stream_callback=stream_callback,
                request_id=request_id,
                provider_display_name=provider_display_name,
                cancel_event=cancel_event,
                task_type=task_type or TASK_IMAGE_CAPTION,
                source=source
            )

            if result["success"]:
                # Decide whether to apply thinking chain output filtering based on configuration
                content = result["content"]
                if filter_thinking_output:
                    content = filter_thinking_content(content)
                return {
                    "success": True,
                    "data": {"description": content}
                }
            else:
                return result

        except Exception as e:
            return {"success": False, "error": format_api_error(e, "VLM Service")}

    @staticmethod
    async def analyze_images(
        images_data: List[str],
        request_id: Optional[str] = None,
        stream_callback: Optional[Callable[[str], None]] = None,
        prompt_content: Optional[str] = None,
        custom_provider: Optional[str] = None,
        custom_provider_config: Optional[Dict[str, Any]] = None,
        cancel_event: Optional[Any] = None,
        task_type: str = None,
        source: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Analyze multiple images using a vision model

        Args:
            images_data: List of image data (Base64 encoded)
            request_id: Request ID
            stream_callback: Streaming output callback
            prompt_content: Custom prompt
            custom_provider: Custom provider
            custom_provider_config: Custom configuration

        Returns:
            Dict: {"success": bool, "data": {"description": str}, "error": str}
        """
        try:
            # Get configuration
            if custom_provider and custom_provider_config:
                provider = custom_provider
                api_key = custom_provider_config.get('api_key')
                model = custom_provider_config.get('model')
                temperature = custom_provider_config.get('temperature', 0.7)
                top_p = custom_provider_config.get('top_p', 0.9)
                max_tokens = custom_provider_config.get('max_tokens', 2000)
                base_url = custom_provider_config.get('base_url', '')
            else:
                config = VisionService._get_config()
                provider = config.get('provider', 'unknown')
                api_key = config.get('api_key')
                model = config.get('model')
                temperature = config.get('temperature', 0.7)
                top_p = config.get('top_p', 0.9)
                max_tokens = config.get('max_tokens', 2000)
                base_url = config.get('base_url', '')

            # Note: Allow empty API Key, supporting unauthenticated providers
            if not model:
                return {"success": False, "error": "Model name not configured"}

            provider_display_name = VisionService.get_provider_display_name(provider)

            from ..utils.common import REQUEST_PREFIX, PREFIX, format_model_with_thinking

            # Check service configuration to determine whether to show thinking chain indicator
            from ..config_manager import config_manager
            service = config_manager.get_service(provider)
            disable_thinking_enabled = service.get('disable_thinking', True) if service else True
            # Only show indicator when the toggle is enabled and the model supports it
            _thinking_check = build_thinking_suppression(provider, model) if disable_thinking_enabled else None
            thinking_disabled = _thinking_check is not None
            model_display = format_model_with_thinking(model, thinking_disabled)

            # Check multi-image support
            supports_multi, max_images = check_multi_image_support(provider, model)
            
            if not supports_multi:
                return {"success": False, "error": f"Model {model} does not support multi-image analysis"}
            
            if len(images_data) > max_images:
                return {"success": False, "error": f"Image count {len(images_data)} exceeds model limit {max_images}"}

            # Preprocess all images (smart compression: dynamically adjust quality based on image count)
            img_count = len(images_data)
            from ..utils.common import get_optimal_image_params
            _, _, compression_level = get_optimal_image_params(img_count)
            
            # Use ProgressBar to manage preprocessing progress
            pbar = ProgressBar(request_id=request_id, service_name="Image Preprocessing", streaming=False)
            processed_images = []
            for idx, img in enumerate(images_data, 1):
                processed = preprocess_image(img, request_id=request_id, silent=True, image_count=img_count)
                processed_images.append(processed)
            
            pbar.done(f"{PREFIX} 🟡 Preprocessing complete: {img_count}/{img_count} | Compression:{compression_level}")

            # Get system prompt
            system_prompt = prompt_content or "Please describe these images in detail, analyzing the relationships and differences between them."

            # Ollama uses native API (determined by service type)
            if service and service.get('type') == 'ollama':
                # Read Ollama service configuration
                from ..config_manager import config_manager
                # Keep type-based check here, no longer hardcoding ID 'ollama'
                disable_thinking_enabled = service.get('disable_thinking', True)
                enable_advanced_params = service.get('enable_advanced_params', False)
                filter_thinking_output = service.get('filter_thinking_output', True)
                _ollama_thinking_extra = build_thinking_suppression(provider, model) if disable_thinking_enabled else None
                
                # Pre-calculate auto_unload configuration
                native_base = base_url[:-3] if base_url.endswith('/v1') else (base_url or 'http://localhost:11434')
                native_base = native_base.rstrip('/')
                _cfg = {
                    'auto_unload': custom_provider_config.get('auto_unload', True) if custom_provider_config else config.get('auto_unload', True),
                    'base_url': native_base
                }
                auto_unload = _cfg['auto_unload']

                # Extract pure base64
                b64_images = [img.split(',')[1] if ',' in img else img for img in processed_images]
                
                result = await VisionService._call_ollama_native_vision(
                    model=model,
                    system_prompt=system_prompt,
                    images_b64=b64_images,
                    temperature=temperature,
                    top_p=top_p,
                    max_tokens=max_tokens,
                    base_url=base_url,
                    stream_callback=stream_callback,
                    request_id=request_id,
                    is_multi=True,
                    auto_unload=auto_unload,
                    enable_advanced_params=enable_advanced_params,
                    thinking_extra=_ollama_thinking_extra,
                    cancel_event=cancel_event,
                    task_type=task_type or TASK_VIDEO_CAPTION,
                    source=source
                )
                
                if result["success"]:
                    # Note: Unloading is handled in _call_ollama_native_vision's finally block

                    # Apply thinking chain output filtering
                    content = result["content"]
                    if filter_thinking_output:
                        content = filter_thinking_content(content)

                    return {
                        "success": True,
                        "data": {"description": content}
                    }
                else:
                    return result

            # Other services use direct HTTP connection
            if not base_url:
                base_url = VisionService.get_provider_base_url(provider, custom_provider_config if custom_provider else None)
            
            # Build multi-image message
            content = [{"type": "text", "text": system_prompt}]
            for img in processed_images:
                content.append({"type": "image_url", "image_url": {"url": img}})
            
            messages = [{"role": "user", "content": content}]
            
            # Check disable_thinking, enable_advanced_params and filter_thinking_output configuration
            from ..config_manager import config_manager
            service = config_manager.get_service(provider)
            disable_thinking_enabled = service.get('disable_thinking', True) if service else True
            enable_advanced_params = service.get('enable_advanced_params', False) if service else False
            filter_thinking_output = service.get('filter_thinking_output', True) if service else True
            thinking_extra = build_thinking_suppression(provider, model) if disable_thinking_enabled else None

            result = await VisionService._http_request_chat_completions(
                base_url=base_url,
                api_key=api_key,
                model=model,
                messages=messages,
                temperature=temperature,
                top_p=top_p,
                max_tokens=max_tokens,
                thinking_extra=thinking_extra,
                enable_advanced_params=enable_advanced_params,
                stream_callback=stream_callback,
                request_id=request_id,
                provider_display_name=provider_display_name,
                cancel_event=cancel_event,
                task_type=task_type or TASK_VIDEO_CAPTION,
                source=source
            )

            if result["success"]:
                # Decide whether to apply thinking chain output filtering based on configuration
                content = result["content"]
                if filter_thinking_output:
                    content = filter_thinking_content(content)
                return {
                    "success": True,
                    "data": {"description": content}
                }
            else:
                return result

        except Exception as e:
            # Ensure progress bar is stopped on exception
            if 'pbar' in locals() and pbar and not getattr(pbar, '_closed', False):
                pbar.error(format_api_error(e, "VLM Service"))
            return {"success": False, "error": format_api_error(e, "VLM Service")}