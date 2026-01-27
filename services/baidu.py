import random
import httpx
from hashlib import md5
import json
import time
import re
from typing import Optional, Dict, Any, List
import asyncio
from ..utils.common import BAIDU_ERROR_CODE_MESSAGES, ProgressBar, log_complete, log_error, TASK_TRANSLATE
from .core import HTTPClientPool

class BaiduTranslateService:
    @staticmethod
    def split_text_by_paragraphs(text, max_length=2000):
        """
        Split text by paragraphs for handling long text translation.
        Uses regex to match consecutive newlines, consistent with the JavaScript version.
        """
        if not text:
            return []

        # Preserve original newlines for later format restoration
        # First split the text into lines by newline characters
        lines = text.split('\n')
        chunks = []
        current_chunk = ""
        
        for line in lines:
            # If the current line itself exceeds max length, split it again
            if len(line) > max_length:
                # If current_chunk is not empty, add it to chunks first
                if current_chunk:
                    chunks.append(current_chunk)
                    current_chunk = ""
                
                # Split long line
                remaining_text = line
                while len(remaining_text) > 0:
                    chunk_text = remaining_text[:max_length]
                    chunks.append(chunk_text)
                    remaining_text = remaining_text[max_length:]
            # If adding current line would exceed length limit, save current chunk first
            elif current_chunk and (len(current_chunk) + len(line) + 1 > max_length):
                chunks.append(current_chunk)
                current_chunk = line
            # Otherwise, add to current chunk
            else:
                if current_chunk:
                    current_chunk += "\n" + line
                else:
                    current_chunk = line
        
        # Add the last chunk
        if current_chunk:
            chunks.append(current_chunk)
        
        return chunks

    @staticmethod
    async def translate_chunk(client, chunk, app_id, secret_key, from_lang, to_lang, retry_count=1):
        """
        Asynchronously translate a single text chunk with retry mechanism.
        """
        for attempt in range(retry_count):
            try:
                # Generate signature
                salt = random.randint(32768, 65536)
                sign = md5((app_id + chunk + str(salt) + secret_key).encode('utf-8')).hexdigest()
                
                # Build request
                url = 'https://fanyi-api.baidu.com/api/trans/vip/translate'
                params = {
                    'q': chunk,
                    'from': from_lang,
                    'to': to_lang,
                    'appid': app_id,
                    'salt': salt,
                    'sign': sign
                }
                
                # Send async request
                response = await client.post(url, data=params)
                
                if response.status_code != 200:
                    if attempt < retry_count - 1:
                        await asyncio.sleep(1)
                        continue
                    raise Exception(f"Baidu: HTTP request failed, status code: {response.status_code}")

                result = response.json()
            
                # Check for errors
                if 'error_code' in result:
                    error_code = result['error_code']
                    error_message = BAIDU_ERROR_CODE_MESSAGES.get(
                        error_code, 
                        f"Unknown error (error code:{error_code})"
                    )
                    
                    # Some error codes can be retried
                    if error_code in ['54003', '52001', '52002'] and attempt < retry_count - 1:
                        await asyncio.sleep(1)
                        continue
                        
                    raise Exception(f"Baidu: {error_message}")

                # Process translation result
                if 'trans_result' in result and result['trans_result']:
                    translated_parts = [item['dst'] for item in result['trans_result']]
                    return '\n'.join(translated_parts)
                else:
                    raise Exception("Baidu: Translation result is empty")
                    
            except (httpx.HTTPError, asyncio.TimeoutError) as e:
                if attempt < retry_count - 1:
                    from ..utils.common import WARN_PREFIX
                    print(f"\r{WARN_PREFIX} Baidu Translate request encountered network error, retrying ({attempt+1}/{retry_count}): {e}")
                    await asyncio.sleep(1)
                else:
                    raise Exception(f"Baidu: Network request failed, please check network connection or try again later ({type(e).__name__})")
            except Exception as e:
                if attempt < retry_count - 1:
                    await asyncio.sleep(1)
                else:
                    if str(e).startswith("Baidu:"):
                        raise e
                    else:
                        raise Exception(f"Baidu: Unknown error occurred during translation ({type(e).__name__})")

        raise Exception("Baidu: Maximum retry count exceeded")

    @staticmethod
    async def translate(text, from_lang='auto', to_lang='zh', request_id=None, is_auto=False, cancel_event=None, task_type=None, source=None):
        """
        Asynchronously call Baidu Translate API for translation.

        Args:
            task_type: Task type, used for unified log output
            cancel_event: Cancel event (kept for interface consistency, Baidu Translate does not support interruption yet)
        """
        try:
            request_id = request_id or f"baidu_trans_{int(time.time())}_{random.randint(1000, 9999)}"
            
            if not text or text.strip() == '':
                return {"success": False, "error": "Baidu: Text to translate cannot be empty"}
            
            from ..config_manager import config_manager
            config = config_manager.get_baidu_translate_config()
            
            app_id = config.get('app_id')
            secret_key = config.get('secret_key')
            
            if not app_id or not secret_key:
                return {"success": False, "error": "Baidu: Please configure Baidu Translate API APP_ID and SECRET_KEY first"}

            # Determine task type
            task_type = task_type or TASK_TRANSLATE

            text_chunks = BaiduTranslateService.split_text_by_paragraphs(text)
            if not text_chunks:
                text_chunks = [text]

            translated_parts = []
            
            # Get HTTP client (reuse connection pool, no proxy)
            # Note: Baidu API is typically faster with direct connection in China, so no proxy parameter is configured
            client = HTTPClientPool.get_client(
                provider="baidu_translate",
                base_url="https://fanyi-api.baidu.com",
                timeout=10.0
            )
            
            # Since HTTPClientPool.get_client returns an AsyncClient instance, we can use it directly.
            # However, to ensure no system proxy is used (simulating trust_env=False), we need to either
            # support this in get_client or manually create the client here.
            # Given HTTPClientPool's current design, manually creating a client without proxy may be more reliable,
            # or we could modify HTTPClientPool to support trust_env=False.
            # For consistency, we use HTTPClientPool, but if forced direct connection is needed, we can pass specific proxy config.

            # In practice, HTTPClientPool.get_client will use system proxy if no proxy is passed.
            # Baidu Translate's previous implementation used trust_env=False (disabled system proxy).
            # For consistency, we manually create a dedicated client here, or modify HTTPClientPool.
            # Given Baidu Translate's specificity (direct connection in China), manually creating a simple client is the safest migration approach.
            
            # Create unified progress bar
            from ..server import is_streaming_progress_enabled
            pbar = ProgressBar(
                request_id=request_id,
                service_name="Baidu Translate",
                streaming=is_streaming_progress_enabled(),
                extra_info=f"Length:{len(text)}",
                task_type=task_type,
                source=source
            )
            
            start_time = time.perf_counter()
            
            async with httpx.AsyncClient(trust_env=False, verify=False, timeout=10.0) as client:
                for i, chunk in enumerate(text_chunks):
                    # ---Interrupt monitoring---
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
                        pbar.cancel(f"{WARN_PREFIX} Task interrupted | Service:Baidu Translate")
                        return {"success": False, "error": "Task interrupted", "interrupted": True}
                    # ------------

                    try:
                        chunk_translation = await BaiduTranslateService.translate_chunk(
                            client, chunk, app_id, secret_key, from_lang, to_lang
                        )
                        translated_parts.append(chunk_translation)

                        if i < len(text_chunks) - 1:
                            await asyncio.sleep(1)

                    except Exception as chunk_error:
                        # Output error log
                        pbar.error(str(chunk_error))
                        return {"success": False, "error": str(chunk_error)}
            
            translated_text = '\n'.join(translated_parts)
            # Completion phase
            elapsed = int((time.perf_counter() - start_time) * 1000)
            pbar.done(char_count=len(translated_text), elapsed_ms=elapsed)

            return {
                "success": True,
                "data": {
                    "translated": translated_text,
                    "from": from_lang,
                    "to": to_lang,
                    "original": text
                }
            }
            
        # Critical fix: separately catch outer CancelledError, ensure pbar is properly stopped
        except asyncio.CancelledError:
            if 'pbar' in locals() and pbar:
                pbar.cancel(f"{WARN_PREFIX} Task externally cancelled | Service:Baidu Translate")
            return {"success": False, "error": "Task cancelled", "interrupted": True}

        except Exception as e:
            # Output error log
            if 'pbar' in locals() and pbar:
                pbar.error(str(e))
            return {"success": False, "error": str(e)}
    
    @staticmethod
    async def batch_translate(texts, from_lang='auto', to_lang='zh'):
        """
        Asynchronously batch translate texts.
        """
        tasks = [BaiduTranslateService.translate(text, from_lang, to_lang) for text in texts]
        return await asyncio.gather(*tasks)