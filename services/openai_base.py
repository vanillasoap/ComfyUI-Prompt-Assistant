"""
OpenAI-compatible service base class
Provides unified OpenAI-compatible API handling logic for LLM and VLM services
"""

import json
import time
import asyncio
import httpx
from typing import Optional, Dict, Any, List, Callable
from .core import BaseAPIService, HTTPClientPool
from ..utils.common import (
    format_api_error, ProgressBar, log_complete, log_error,
    PREFIX, PROCESS_PREFIX, WARN_PREFIX, ERROR_PREFIX, format_elapsed_time
)
from .thinking_control import build_thinking_suppression
import re


# ==================== Thinking chain output filtering ====================

def filter_thinking_content(text: str) -> str:
    """
    Filter thinking chain content from model output.
    Supports multiple tag formats: <think>, <reasoning>, <thoughts>

    Args:
        text: Original model output text

    Returns:
        str: Filtered text
    """
    if not text:
        return text
    
    # 1. Prioritize matching paired thinking chain tags
    # Match <think>...</think> and similar paired structures
    pattern_pair = r'<(think|thinking|reasoning|thoughts?)>[\s\S]*?</\1>'
    text = re.sub(pattern_pair, '', text, flags=re.IGNORECASE)
    
    # 2. Fallback handling: if orphan closing tags remain (possibly missing opening tag), remove the tag and all content before it
    # Assumption: thinking process always appears at the beginning of the response
    pattern_orphan_end = r'^[\s\S]*?</(think|thinking|reasoning|thoughts?)>'
    text = re.sub(pattern_orphan_end, '', text, flags=re.IGNORECASE)
    
    return text.strip()


class OpenAICompatibleService(BaseAPIService):
    """
    OpenAI-compatible API service base class
    Handles all OpenAI-format API requests (Zhipu, SiliconFlow, 302.ai, Ollama, etc.)
    """
    
    # ---Known API endpoint paths (for smart detection)---
    _known_endpoints = ['/chat/completions', '/v1/messages', '/completions']
    
    @staticmethod
    def parse_api_url(raw_url: str) -> str:
        """
        Smart parse base_url to generate final request URL.

        Rules:
        1. Ends with '#' -> Force use full address (remove #)
        2. Already contains known endpoint path -> Use directly, no appending
        3. Otherwise -> Normally append /chat/completions

        Args:
            raw_url: User-provided raw URL

        Returns:
            str: Final request URL
        """
        if not raw_url:
            return ''
        
        url = raw_url.strip()
        
        # Rule 1: Hash force mode - User explicitly requests using the full address
        if url.endswith('#'):
            return url[:-1].rstrip('/')
        
        # Rule 2: Smart detection - Check if URL already contains known API endpoints
        for endpoint in OpenAICompatibleService._known_endpoints:
            if endpoint in url:
                # Already contains full endpoint, return directly (remove trailing slash)
                return url.rstrip('/')
        
        # Rule 3: Normal mode - Need to append /chat/completions
        return url.rstrip('/') + '/chat/completions'
    
    # _provider_base_urls and _provider_display_names have been removed, related logic is now managed by config_manager
    
    @staticmethod
    def _filter_payload(payload: Dict[str, Any], level: int) -> Dict[str, Any]:
        """
        Clean request body based on retry level (simplified three-level degradation strategy)

        Level 0: Full request (sent with user settings)
        Level 1: Remove thinking chain parameters (thinking, enable_thinking, reasoning_effort, etc.)
        Level 2: Minimum viable set (only model, messages, stream)
        """
        if level <= 0:
            return payload.copy()
            
        filtered = payload.copy()
        
        # Level 1: Remove thinking chain parameters
        thinking_keys = [
            "thinking", "enable_thinking", "reasoning_effort", 
            "reasoning", "thinking_level", "think"
        ]
        for k in thinking_keys:
            filtered.pop(k, None)
            
        if level >= 2:
            # Level 2: Minimum viable set - keep only required parameters
            core_keys = ["model", "messages", "stream"]
            filtered = {k: filtered[k] for k in core_keys if k in filtered}
            
        return filtered

    @staticmethod
    def _merge_system_prompts(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Merge multiple System Messages into a single entry
        and place the System Message at the beginning of the list.
        Solves the issue where some providers don't support multiple System Messages.
        """
        system_contents = []
        other_messages = []
        
        for msg in messages:
            if msg.get('role') == 'system':
                content = msg.get('content', '')
                if content:
                    system_contents.append(content)
            else:
                other_messages.append(msg)
        
        if not system_contents:
            return messages
            
        # Merge content
        merged_system = "\n\n".join(system_contents)
        
        # Build new list: System first + other messages
        return [{"role": "system", "content": merged_system}] + other_messages

    @classmethod
    async def _http_request_chat_completions(
        cls,
        base_url: str,
        api_key: str,
        model: str,
        messages: List[Dict[str, Any]],
        temperature: float = 0.7,
        top_p: float = 0.9,
        max_tokens: int = 2000,
        thinking_extra: Optional[Dict[str, Any]] = None,
        enable_advanced_params: bool = False,
        stream_callback: Optional[Callable[[str], None]] = None,
        request_id: Optional[str] = None,
        provider_display_name: str = "未知服务",
        cancel_event: Optional[Any] = None,
        task_type: str = None,
        source: str = None
    ) -> Dict[str, Any]:
        """
        Call /chat/completions endpoint using direct HTTP connection.
        Unified handling for all OpenAI-compatible providers (supports three-level degradation retry)

        Args:
            enable_advanced_params: Whether to send advanced parameters (temperature/top_p/max_tokens)
        """
        from ..server import is_streaming_progress_enabled
        
        try:
            # Build request URL
            url = cls.parse_api_url(base_url)
            
            # Preprocessing: merge System Prompts (applied by default at Level 0)
            merged_messages = cls._merge_system_prompts(messages)
            
            # Build base request body (required parameters only)
            initial_payload = {
                "model": model,
                "messages": merged_messages,
                "stream": True
            }
            
            # Only send temperature, top_p, max_tokens when user enables "advanced parameters"
            if enable_advanced_params:
                initial_payload["temperature"] = temperature
                initial_payload["top_p"] = top_p
                initial_payload["max_tokens"] = max_tokens
            
            # Add thinking chain control parameters
            if thinking_extra:
                initial_payload.update(thinking_extra)
            
            # Build request headers
            headers = {"Content-Type": "application/json"}
            if api_key and api_key.strip():
                headers["Authorization"] = f"Bearer {api_key}"
            
            # Get HTTP client
            client = HTTPClientPool.get_client(
                provider=provider_display_name,
                base_url=base_url,
                timeout=60.0
            )

            # Pre-check for interruption: if ComfyUI has already interrupted, don't start the request
            from server import PromptServer
            if hasattr(PromptServer.instance, 'execution_interrupted') and PromptServer.instance.execution_interrupted:
                return {"success": False, "error": "Task interrupted", "interrupted": True}

            # Create unified progress bar (automatically handles waiting -> generating -> done lifecycle)
            pbar = ProgressBar(
                request_id=request_id,
                service_name=provider_display_name,
                streaming=is_streaming_progress_enabled(),
                task_type=task_type,
                source=source
            )
            
            start_time = time.perf_counter()
            last_error_msg = ""
            
            # Three-level degradation retry loop (Level 0 -> Level 2)
            for retry_level in range(3):
                current_payload = cls._filter_payload(initial_payload, retry_level)
                
                # If not Level 0, print degradation retry warning (with newline)
                if retry_level > 0:
                    removed_keys = set(initial_payload.keys()) - set(current_payload.keys())
                    removed_str = ", ".join(removed_keys) if removed_keys else "No parameter changes"
                    print(f"\n{WARN_PREFIX} ⚠️ HTTP 400 error, triggering Level-{retry_level} degradation retry | Service:{provider_display_name} | Removed params:[{removed_str}]", flush=True)
                    
                    # Critical fix: stop old progress bar before creating new one to prevent thread leaks
                    if pbar:
                        try:
                            pbar.error(f"Retry Level {retry_level}...") # 标记前一个进度条为错误/重试状态
                        except:
                            pbar._stop_timer()

                    
                    # Recreate progress bar for new retry round
                    pbar = ProgressBar(
                        request_id=request_id,
                        service_name=provider_display_name,
                        extra_info=f"Retry-{retry_level}",
                        streaming=is_streaming_progress_enabled(),
                        task_type=task_type,
                        source=source
                    )
                
                async def _do_stream_request():
                    nonlocal pbar
                    
                    # Define request core logic
                    async def _request_core():
                        async with client.stream('POST', url, headers=headers, json=current_payload, follow_redirects=True) as response:
                            if response.status_code != 200:
                                error_text = await response.aread()
                                try:
                                    error_data = json.loads(error_text)
                                    msg = error_data.get('error', {}).get('message', f'HTTP {response.status_code}')
                                except:
                                    msg = f'HTTP {response.status_code}: {error_text.decode("utf-8", errors="ignore")[:200]}'
                                
                                # Smart recognition of authentication errors
                                from ..utils.common import _is_auth_error
                                if response.status_code == 401 or _is_auth_error(msg.lower()):
                                    msg = "API Key invalid or missing"
                                
                                return {
                                    "success": False, 
                                    "error": msg, 
                                    "status_code": response.status_code,
                                    "should_retry": response.status_code == 400
                                }
                            
                            full_content = ""
                            reasoning_content = ""
                            
                            async for line in response.aiter_lines():
                                # 此处的循环检查依然保留，作为双重保险
                                if cancel_event is not None and cancel_event.is_set():
                                    raise asyncio.CancelledError()
                                
                                if not line or line == "data: [DONE]" or line == "data:[DONE]": continue
                                if line.startswith("data: "): line = line[6:]
                                elif line.startswith("data:"): line = line[5:]
                                
                                try:
                                    chunk = json.loads(line)
                                    # --- 调试日志 (2级): 输出原始流式数据 ---
                                    # print(f"[DEBUG-2] Chunk: {line[:200]}...", flush=True)
                                    
                                    if chunk.get('choices'):
                                        delta = chunk['choices'][0].get('delta', {})
                                        content = delta.get('content', '') or ''
                                        # 针对不同厂商的推理字段进行广谱捕获
                                        reasoning = (
                                            delta.get('reasoning_content', '') or 
                                            delta.get('reasoning', '') or 
                                            delta.get('thinking', '') or 
                                            delta.get('thinking_process', '') or  # 备选
                                            ''
                                        )
                                        if reasoning: reasoning_content += reasoning
                                        if content:
                                            full_content += content
                                            if stream_callback: stream_callback(content)
                                            pbar.set_generating(len(full_content))
                                            pbar.update(len(full_content))
                                except:
                                    continue
                            
                            final_content = full_content
                            if reasoning_content:
                                final_content = f"<think>{reasoning_content}</think>\n{full_content}"
                            
                            elapsed_ms = int((time.perf_counter() - start_time) * 1000)
                            if not final_content.strip():
                                pbar.error("响应内容为空")
                                # --- 调试日志 (1级): 警告响应内容为空 ---
                                print(f"\n{WARN_PREFIX} [API响应调试] 模型:{model} | 状态:成功 | 但最终内容为空字符串", flush=True)
                            else:
                                pbar.done(char_count=len(final_content), elapsed_ms=elapsed_ms)
                            
                            return {"success": True, "content": final_content}

                    # 定义监视器逻辑：每100ms检查一次中断信号
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
                                except:
                                    pass
                            
                            if is_interrupted:
                                target_task.cancel()
                                return True
                            await asyncio.sleep(0.1)
                        return False

                    # 并发运行请求和监视器
                    req_task = asyncio.create_task(_request_core())
                    monitor_task = asyncio.create_task(_monitor_interrupts(req_task))
                    
                    try:
                        result = await req_task
                        # 关键修复：API 返回错误时，确保进度条被停止
                        if not result.get("success") and not result.get("interrupted"):
                            if not getattr(pbar, '_closed', False):
                                pbar.error(result.get("error", "API 错误"))
                        return result
                    except asyncio.CancelledError:
                        pbar.cancel(f"{WARN_PREFIX} 任务被中断 | 服务:{provider_display_name}")
                        return {"success": False, "error": "中断", "interrupted": True}
                    finally:
                        if not monitor_task.done():
                            monitor_task.cancel()

                # 执行请求
                try:
                    result = await _do_stream_request()
                except Exception as req_err:
                    # 网络层面的异常（非HTTP响应），通常不适合通过参数降级解决，除非确认是特定的协议问题
                    # 这里选择继续抛出或作为错误返回，不盲目重试
                    # 但为了稳健，如果是非连接已建立后的错误，可以选择不重试
                    # 为简单起见，仅记录错误
                    if 'pbar' in locals() and pbar:
                        pbar.error(f"网络请求异常: {req_err}")
                    return {"success": False, "error": f"网络请求异常: {req_err}"}

                # 检查结果
                if result["success"]:
                    # Ollama 服务成功后尝试卸载模型
                    if provider_display_name.lower().find("ollama") != -1:
                        try:
                            from ..config_manager import config_manager
                            service_config = config_manager.get_service(provider_display_name) or {}
                            await cls._unload_ollama_model(model, service_config)
                        except:
                            pass
                    return result
                
                if result.get("interrupted"):
                    return result

                last_error_msg = result["error"]
                
                # 只有 should_retry 为 True (HTTP 400) 且还有重试机会时，才继续循环
                if not result.get("should_retry"):
                    break # 非400错误（如401, 500等），不进行降级重试，直接返回错误
            
            # 所有重试耗尽或非可重试错误
            if 'pbar' in locals() and pbar:
                pbar.error(last_error_msg)
            return {"success": False, "error": last_error_msg}
        
        # 关键修复：单独捕获 CancelledError，确保进度条被正确停止
        except asyncio.CancelledError:
            if 'pbar' in locals() and pbar:
                pbar.cancel(f"{WARN_PREFIX} 任务被外部取消 | 服务:{provider_display_name}")
            return {"success": False, "error": "任务被取消", "interrupted": True}
                    
        except Exception as e:
            if 'pbar' in locals() and pbar:
                pbar.error(format_api_error(e, provider_display_name))
            return {"success": False, "error": format_api_error(e, provider_display_name)}
    
    @staticmethod
    async def _unload_ollama_model(model: str, provider_config: Dict[str, Any]):
        """
        卸载Ollama模型以释放显存和内存
        
        参数:
            model: 模型名称
            provider_config: 提供商配置字典
        """
        try:
            # 检查是否启用自动释放
            auto_unload = provider_config.get('auto_unload', True)
            if not auto_unload:
                from ..utils.common import PROCESS_PREFIX
                print(f"{PROCESS_PREFIX} Ollama模型已保留 | 模型:{model}")
                return
            
            # 获取base_url
            base_url = provider_config.get('base_url', 'http://localhost:11434')
            if base_url.endswith('/v1'):
                base_url = base_url[:-3]
            
            # 调用Ollama API卸载模型
            url = f"{base_url}/api/generate"
            payload = {
                "model": model,
                "keep_alive": 0
            }
            
            # 创建临时客户端（卸载操作不需要复用）
            async with httpx.AsyncClient(timeout=5.0) as client:
                response = await client.post(url, json=payload)
                if response.status_code == 200:
                    from ..utils.common import PROCESS_PREFIX
                    print(f"{PROCESS_PREFIX} Ollama模型已释放 | 模型:{model}")
                
        except Exception as e:
            from ..utils.common import WARN_PREFIX
            print(f"{WARN_PREFIX} Ollama模型释放失败（不影响结果） | 模型:{model} | 错误:{str(e)[:50]}")
    
    @classmethod
    def get_provider_display_name(cls, provider: str) -> str:
        """
        获取提供商显示名称
        优先从config_manager获取服务的真实名称，兜底使用provider key
        """
        # 优先尝试从config_manager获取服务名称
        try:
            from ..config_manager import config_manager
            service = config_manager.get_service(provider)
            if service and 'name' in service:
                return service['name']
        except Exception:
            pass
        
        # 兜底直接返回key
        return provider
    
    @classmethod
    def get_provider_base_url(cls, provider: str, config: Optional[Dict[str, Any]] = None) -> Optional[str]:
        """
        获取提供商的base_url
        仅用于custom provider的逻辑，其他情况应直接从config获取
        """
        if provider == 'custom' and config:
            base_url = config.get('base_url')
            # 确保base_url不以/chat/completions结尾
            if base_url and base_url.endswith('/chat/completions'):
                base_url = base_url[:-len('/chat/completions')]
            return base_url
        
        return None
