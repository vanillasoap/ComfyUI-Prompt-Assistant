"""
Utility functions module
Integrates error handling, image processing, constant definitions, and other common utilities
"""

import json
import base64
import sys
import os
import shutil
import re
import io
from io import BytesIO
from PIL import Image
from typing import Optional, Dict, Any
import time
import random
import threading

# Fix Windows terminal encoding issues
# Resolve emoji and special character output errors caused by GBK encoding
if sys.platform == 'win32' and sys.stdout.encoding != 'utf-8':
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')
    except Exception:
        pass  # Fail silently, keep original encoding


# ==================== Unified Display Width Calculation ====================

def get_display_width(text: str) -> int:
    """
    Calculate the display width of a string in the terminal (CJK characters and some emoji take 2 columns, ASCII takes 1)
    """
    width = 0
    for char in text:
        # Common CJK character encoding ranges
        if ord(char) > 0x7F:
            width += 2
        else:
            width += 1
    return width


# ==================== Unified Log Prefix Constants ====================
# All modules import from here to ensure consistent log formatting

PREFIX = "✨"
ERROR_PREFIX = "✨-❌"
PROCESS_PREFIX = "✨"
REQUEST_PREFIX = "✨"
WARN_PREFIX = "✨-⚠️"


# ==================== Task Type Constants ====================
TASK_TRANSLATE = "Translation"
TASK_EXPAND = "Prompt Optimization"
TASK_IMAGE_CAPTION = "Image Captioning"
TASK_VIDEO_CAPTION = "Video Captioning"


# ==================== Request Source Constants ====================
SOURCE_NODE = "Node-"
SOURCE_FRONTEND = "Frontend-"


# ==================== Unified Log Message Functions ====================

def log_prepare(
    task_type: str,
    request_id: str,
    source: str,
    service_name: str,
    model_name: str = None,
    rule_name: str = None,
    extra: dict = None
) -> None:
    """
    Output a unified format preparation log (with newline)

    Format: ✨ 🟡 {source}{task}Preparing | Service:{service} | Model:{model} | Rule:{rule} | ID:{id}
    """
    # Force return to line start and clear current line to avoid conflicts with previous progress
    print(f"\r{_ANSI_CLEAR_EOL}", end="")

    parts = [f"{PREFIX} 🟡 {source}{task_type}Preparing"]
    parts.append(f"Service:{service_name}")

    if model_name:
        parts.append(f"Model:{model_name}")
    if rule_name:
        parts.append(f"Rule:{rule_name}")

    parts.append(f"ID:{request_id}")

    # Process extra fields
    if extra:
        for key, value in extra.items():
            parts.append(f"{key}:{value}")
    
    print(f"{parts[0]} | {' | '.join(parts[1:])}", flush=True)


def log_complete(
    task_type: str,
    request_id: str,
    service_name: str,
    char_count: int,
    elapsed_ms: int,
    model_unloaded: bool = None,
    source: str = None
) -> None:
    """
    Output a unified format completion log (with newline)

    Format: ✨ ✅ {source}{task}Complete | Service:{service} | ID:{id} | Chars:{count} | Elapsed:{time}
    """
    # Force return to line start without newline, clear current line, then output new message
    print(f"\r{_ANSI_CLEAR_EOL}", end="")

    elapsed_str = format_elapsed_time(elapsed_ms)
    source_str = source if source else ""
    parts = [f"{PREFIX} ✅ {source_str}{task_type}Complete"]
    parts.append(f"Service:{service_name}")
    parts.append(f"ID:{request_id}")
    parts.append(f"Chars:{char_count}")
    parts.append(f"Elapsed:{elapsed_str}")

    # Ollama model unload status
    if model_unloaded is not None:
        unload_text = "Model unloaded" if model_unloaded else "Model retained"
        parts.append(unload_text)
    
    print(f"{parts[0]} | {' | '.join(parts[1:])}", flush=True)


def log_error(
    task_type: str,
    request_id: str,
    error_msg: str,
    source: str = None
) -> None:
    """
    Output a unified format error log (with newline)
    """
    # Force return to line start and clear current line
    print(f"\r{_ANSI_CLEAR_EOL}", end="")
    source_str = source if source else ""
    print(f"{PREFIX} ❌ {source_str}{task_type}Failed | ID:{request_id} | Error:{error_msg}", flush=True)


def generate_request_id(req_type: str, service_type: Optional[str] = None, node_id: str = "0") -> str:
    """
    Generate a unified format request ID
    Format: request_type_service_type(optional)_NodeID_four_digit_timestamp
    Example: trans_llm_12_3456
    """
    timestamp = str(int(time.time()))[-4:]
    parts = [req_type]
    if service_type:
        parts.append(service_type)
    parts.append(str(node_id))
    parts.append(timestamp)
    return "_".join(parts)


# ---Log Formatting Helper Functions---

def simplify_model_name(model: str) -> str:
    """
    Simplify model name for display

    Examples:
        huihui_ai/qwen3-vl-abliterated:8b -> qwen3-vl-8b
        huihui_ai/qwen3-abliterated:14b -> qwen3-14b

    Args:
        model: Full model name

    Returns:
        Simplified model name
    """
    if '/' in model:
        model = model.split('/')[-1]
    if ':' in model:
        name, size = model.split(':')
        # Remove common suffixes
        name = name.replace('-abliterated', '').replace('-instruct', '').replace('-chat', '')
        return f"{name}-{size}"
    return model

def format_model_with_thinking(model: str, thinking_disabled: bool = False) -> str:
    """
    Format model name, adding a thinking indicator if chain-of-thought is disabled

    Args:
        model: Model name
        thinking_disabled: Whether chain-of-thought is disabled

    Returns:
        Formatted model name
    """
    simplified = simplify_model_name(model)
    if thinking_disabled:
        return f"{simplified}💭"
    return simplified

def format_elapsed_time(elapsed_ms: int) -> str:
    """
    Format elapsed time for display

    Args:
        elapsed_ms: Milliseconds

    Returns:
        Formatted time string (e.g. "6.5s")
    """
    return f"{elapsed_ms/1000:.1f}s"


# ====================Progress Log System====================
# Unified progress bar manager with single-line overwrite refresh

# ---ANSI Control Sequences---
_ANSI_CLEAR_EOL = "\033[K"  # Clear from cursor position to end of line

# ---Global State: Track last output length (lock-protected for concurrency)---
_global_last_output_len = 0
_progress_lock = threading.Lock()


# ---Windows Virtual Terminal Initialization---
def _enable_windows_vt():
    """
    Enable Windows virtual terminal processing
    Resolve ANSI escape sequence compatibility issues in Windows CMD/PowerShell
    """
    if os.name == 'nt':
        try:
            import ctypes
            kernel32 = ctypes.windll.kernel32
            handle = kernel32.GetStdHandle(-11)  # STD_OUTPUT_HANDLE
            mode = ctypes.c_ulong()
            kernel32.GetConsoleMode(handle, ctypes.byref(mode))
            kernel32.SetConsoleMode(handle, mode.value | 0x0004)  # ENABLE_VIRTUAL_TERMINAL_PROCESSING
        except Exception:
            pass

_enable_windows_vt()


class ProgressBar:
    """
    Unified progress bar manager

    Manages the full lifecycle of a request: waiting -> generating -> done
    Controls refresh frequency via the streaming parameter:
    - streaming=True: High-frequency refresh (refresh on every update)
    - streaming=False: Refresh only on state changes (waiting->generating->done)

    Both modes use single-line overwrite (\\r), differing only in refresh frequency
    """

    # State constants
    STATE_WAITING = "waiting"
    STATE_GENERATING = "generating"
    STATE_DONE = "done"
    def __init__(
        self,
        request_id: str,
        service_name: str,
        extra_info: str = None,
        streaming: bool = True,
        task_type: str = None,
        source: str = None
    ):
        """
        Create a progress bar

        Args:
            request_id: Request ID
            service_name: Service name (e.g. Ollama, OpenAI)
            extra_info: Extra info (e.g. Context:2048 | Timeout:60s)
            streaming: True=high-frequency refresh, False=refresh only on state changes
            task_type: Task type (for unified logging)
            source: Source (frontend/node)
        """
        self._request_id = request_id
        self._service_name = service_name
        self._extra_info = extra_info
        self._streaming = streaming
        self._task_type = task_type
        self._source = source
        
        self._state = self.STATE_WAITING
        self._char_count = 0
        self._start_time = time.perf_counter()
        self._closed = False
        self._stop_event = threading.Event()
        self._timer_thread = None
        
        # 1. Reset global length, start new progress tracking round
        with _progress_lock:
            global _global_last_output_len
            _global_last_output_len = 0

        # Immediately display "waiting for response"
        self._refresh()

        # Only start timed refresh thread in streaming mode (non-streaming uses static logs, no ticking refresh needed)
        if self._streaming:
            self._timer_thread = threading.Thread(target=self._timer_loop, daemon=True)
            self._timer_thread.start()
    
    def _format_elapsed(self) -> str:
        """Format elapsed time"""
        elapsed_sec = time.perf_counter() - self._start_time
        if elapsed_sec < 60:
            return f"{elapsed_sec:.1f}s"
        else:
            minutes = int(elapsed_sec // 60)
            seconds = int(elapsed_sec % 60)
            return f"{minutes}m{seconds}s"
    
    def _render(self) -> str:
        """Render current progress bar content"""
        elapsed = self._format_elapsed()

        if self._state == self.STATE_WAITING:
            # Waiting for response: ✨ 🟠 Waiting for Ollama response...
            # In streaming mode add timer, non-streaming mode stays static
            base = f"{PREFIX} 🟠 Waiting for {self._service_name} response..."
            if not self._streaming:
                return base

            if self._extra_info:
                return f"{base} | {self._extra_info} | {elapsed}"
            else:
                return f"{base} | {elapsed}"

        elif self._state == self.STATE_GENERATING:
            # Streaming mode: show character count and time
            # Static mode: show simple "Generating..."
            if self._streaming:
                return f"{PREFIX} 🔵 Generating | {self._char_count} chars | {elapsed}"
            else:
                return f"{PREFIX} 🔵 Generating..."
        
        else:
            return ""
    
    def _refresh(self) -> None:
        """Internal refresh method: single-line overwrite output"""
        if self._closed:
            return
        
        output = self._render()
        if not output:
            return
        
        with _progress_lock:
            global _global_last_output_len
            # Calculate display width of current content (fixes len() inaccuracy due to CJK/emoji)
            current_width = get_display_width(output)

            # Pad with spaces to overwrite previous longer output (fallback for ANSI failure)
            padding = ""
            if _global_last_output_len > current_width:
                padding = " " * (_global_last_output_len - current_width)
            
            # Use \r to return to line start, send ANSI clear line first (instant clear if supported)
            # Then output content + space padding (for ANSI failure) + clear line again (prevent trailing residue)
            # Add 2 space buffer to avoid sticking to other log output
            print(f"\r{_ANSI_CLEAR_EOL}{output}{padding}{_ANSI_CLEAR_EOL}  ", end='', flush=True)
            
            # Record this display width (including buffer spaces)
            _global_last_output_len = current_width + len(padding)

    def _stop_timer(self):
        """Stop the timer thread"""
        self._stop_event.set()
        # Force state to closed to prevent re-entry
        self._closed = True

    def _timer_loop(self):
        """Background thread: periodically refresh timer in streaming mode only"""
        try:
            while not self._stop_event.is_set() and not self._closed:
                # Periodically refresh current content (mainly for updating time during WAITING phase)
                self._refresh()

                # Refresh every 0.1 seconds
                if self._stop_event.wait(0.1):
                    break
        except Exception:
            pass # Daemon thread exceptions should not affect the main flow
    
    def set_generating(self, char_count: int = 0) -> None:
        """
        Switch to "generating" state

        Args:
            char_count: Current character count
        """
        if self._closed or self._state == self.STATE_GENERATING:
            return
        
        self._state = self.STATE_GENERATING
        self._char_count = char_count
        self._refresh()  # Always refresh on state change
    
    def update(self, char_count: int) -> None:
        """
        Update character count

        Streaming mode: refresh on every call
        Static mode: no refresh (avoid flooding)

        Args:
            char_count: Current character count
        """
        if self._closed:
            return
        
        self._char_count = char_count
        
        # Streaming mode: high-frequency refresh
        if self._streaming:
            self._refresh()
        # Static mode: no refresh here, only refresh on state changes
    
    def done(self, message: str = None, char_count: int = None, elapsed_ms: int = None) -> None:
        """
        Complete the request

        Args:
            message: Custom completion message (optional)
            char_count: Final character count (optional)
            elapsed_ms: Elapsed milliseconds (optional, auto-calculated if not provided)
        """
        if self._closed:
            return
        
        self._stop_timer()
        self._state = self.STATE_DONE


        # Reset global length
        with _progress_lock:
            global _global_last_output_len
            _global_last_output_len = 0

        # If task_type is provided, use unified logging
        if hasattr(self, '_task_type') and self._task_type:
            log_complete(
                self._task_type or "Task",
                self._request_id,
                self._service_name,
                char_count if char_count is not None else self._char_count,
                elapsed_ms if elapsed_ms is not None else int((time.perf_counter() - self._start_time) * 1000),
                source=getattr(self, '_source', None)
            )
            return

        # Fallback compatibility: original done logic
        # Calculate elapsed time
        if elapsed_ms is not None:
            elapsed = format_elapsed_time(elapsed_ms)
        else:
            elapsed = self._format_elapsed()
        
        # Use provided character count or current recorded count
        final_count = char_count if char_count is not None else self._char_count

        # Generate completion message
        if message:
            final_msg = message
        else:
            final_msg = f"{PREFIX} ✅ Complete | Service:{self._service_name} | ID:{self._request_id} | Chars:{final_count} | Elapsed:{elapsed}"

        # Following log_complete's approach: output with newline, don't overwrite previous content
        print(f"\r{_ANSI_CLEAR_EOL}{final_msg}", flush=True)
    
    def error(self, message: str) -> None:
        """
        Output error message (with newline, no overwrite)

        Args:
            message: Error message
        """
        if self._closed:
            return
        
        self._stop_timer()



        # Reset global length
        with _progress_lock:
            global _global_last_output_len
            _global_last_output_len = 0

        # If task_type is provided, use unified logging
        if hasattr(self, '_task_type') and self._task_type:
            log_error(self._task_type or "Task", self._request_id, message, source=getattr(self, '_source', None))
            return

        # Fallback mode
        print(f"\r{_ANSI_CLEAR_EOL}{message}", flush=True)

    def cancel(self, message: str = None) -> None:
        """
        Cancel the request (with newline, no overwrite)

        Args:
            message: Custom cancel message (optional)
        """
        if self._closed:
            return
        
        self._stop_timer()



        # Reset global length
        with _progress_lock:
            global _global_last_output_len
            _global_last_output_len = 0

        cancel_msg = message or "Task cancelled"

        # If task_type is provided, use unified logging
        if hasattr(self, '_task_type') and self._task_type:
            log_error(self._task_type or "Task", self._request_id, cancel_msg, source=getattr(self, '_source', None))
            return

        # Fallback mode
        print(f"\r{_ANSI_CLEAR_EOL}{WARN_PREFIX} {cancel_msg} | ID:{self._request_id}", flush=True)
    
    def __enter__(self):
        return self
    
    def __exit__(self, *args):
        if not self._closed:
            # When exiting context, if done/error was not explicitly called, treat as successful completion
            self.done()

    def __del__(self):
        """Destructor: ensure timer is stopped when object is garbage collected"""
        try:
            # Only attempt to stop if timer is still running
            if hasattr(self, '_stop_event') and not self._stop_event.is_set():
                self._stop_timer()
        except:
            pass








# HTTP status code to error message mapping
HTTP_STATUS_CODE_MESSAGES = {
    400: "Invalid request",
    401: "Authentication failed - please check if your API Key is correct.",
    403: "Access denied - you do not have permission to access this resource.",
    404: "Requested resource not found",
    429: "Too many requests - you have exceeded the rate limit, please try again later.",
    500: "Internal server error - an unknown issue occurred on the service provider side.",
    502: "Bad gateway",
    503: "Service unavailable - the server cannot process the request at this time, please try again later.",
    504: "Gateway timeout",
}

# Baidu Translate API error code mapping
BAIDU_ERROR_CODE_MESSAGES = {
    '52001': 'Request timeout, please retry',
    '52002': 'System error, please retry',
    '52003': 'Unauthorized user, please check if appid is correct or if the service is enabled',
    '54000': 'Required parameter is empty, please check if any parameters are missing',
    '54001': 'Signature error, please check if appid and secret_key are correct',
    '54003': 'Access frequency limited, please reduce your call frequency, or switch to advanced/premium version after authentication',
    '54004': 'Insufficient account balance, please top up in the management console',
    '54005': 'Long query requests too frequent, please reduce the frequency of long queries, retry after 3s',
    '58000': 'Invalid client IP, check if the IP address in your profile is correct, you can modify it in Developer Info - Basic Info',
    '58001': 'Translation language direction not supported, check if the target language is in the language list',
    '58002': 'Service is currently closed, please enable it in the Baidu management console',
    '58003': 'This IP has been banned',
    '90107': 'Authentication not passed or not effective, please check authentication progress in My Authentication',
    '20003': 'Request content has security risks',
}


# ---Error Handling Functions---

def _is_auth_error(error_text: str) -> bool:
    """
    Check if the error message is an authentication-related error

    Args:
        error_text: Error text (lowercase)

    Returns:
        bool: Whether it is an authentication error
    """
    auth_keywords = [
        'invalid token',
        'authorization',
        'authenticate',
        'api key',
        'api_key',
        'unauthorized',
        'auth failed',
        'invalid key',
        'missing key',
        'invalid credentials',
        'authentication',
        'auth failed',
        'token'
    ]
    return any(keyword in error_text for keyword in auth_keywords)

def format_api_error(e: Exception, provider_display_name: str) -> str:
    """
    Format error messages from API calls
    Pure httpx implementation, no dependency on openai library

    Args:
        e: Exception object
        provider_display_name: Service provider display name

    Returns:
        str: Formatted error message
    """
    # Handle httpx HTTP errors
    try:
        import httpx
        if isinstance(e, httpx.HTTPStatusError):
            status_code = e.response.status_code
            message = HTTP_STATUS_CODE_MESSAGES.get(status_code, "Unknown HTTP error")
            
            error_details_str = ""
            detail_msg = ""
            
            try:
                error_details = e.response.json()
                detail_msg = error_details.get("message", "")
                if isinstance(error_details.get("error"), dict):
                    detail_msg = error_details["error"].get("message", detail_msg)
                
                if detail_msg:
                    error_details_str = f" | Details: {detail_msg}"
            except (json.JSONDecodeError, AttributeError):
                try:
                    if hasattr(e.response, 'text') and e.response.text:
                        detail_msg = e.response.text[:200]
                        error_details_str = f" | Raw response: {detail_msg}"
                except Exception:
                    pass
            
            # ---Smart detection of auth errors with friendly message---
            combined_error_text = f"{message} {detail_msg}".lower()
            if status_code == 401 or _is_auth_error(combined_error_text):
                return f"{provider_display_name} Authentication failed: API Key not configured or invalid, please enter a valid API Key in the service provider settings"

            return f"{provider_display_name} API error: {message} (Status code: {status_code}){error_details_str}"
    except Exception:
        pass
        
    # For other exception types, return type and basic info
    return f"{provider_display_name} service request exception: ({type(e).__name__}) {str(e)}"


def format_baidu_translate_error(error_data: dict) -> str:
    """
    Format Baidu Translate API error messages

    Args:
        error_data: Error data returned by Baidu API

    Returns:
        str: Formatted error message
    """
    if not isinstance(error_data, dict):
        return "Unknown Baidu Translate error format"

    error_code = str(error_data.get('error_code'))
    if error_code in BAIDU_ERROR_CODE_MESSAGES:
        return f"Baidu Translate error: {BAIDU_ERROR_CODE_MESSAGES[error_code]} (Code: {error_code})"

    error_msg = error_data.get('error_msg', 'Unknown error')
    return f"Baidu Translate error: {error_msg} (Code: {error_code})"


# ---Image Processing Functions---

def get_optimal_image_params(image_count: int = 1) -> tuple:
    """
    Intelligently calculate optimal resolution and quality parameters based on image count
    Goal: ensure API can return complete results while maintaining image quality as much as possible

    Args:
        image_count: Number of images (1-32)

    Returns:
        tuple: (max_size: tuple, quality: int, compression_level: str)
    """
    if image_count <= 1:
        # Single image: use medium quality
        return (1024, 1024), 75, "Medium"
    elif image_count <= 3:
        # 1-3 frames: maintain higher quality
        return (1024, 1024), 70, "High"
    elif image_count <= 6:
        # 4-6 frames: reduce resolution, maintain medium quality
        return (768, 768), 70, "Medium"
    elif image_count <= 10:
        # 7-10 frames: further reduce resolution and quality
        return (640, 640), 65, "Low"
    elif image_count <= 16:
        # 11-16 frames: use low resolution
        return (512, 512), 60, "Lower"
    else:
        # 17-32 frames: maximum compression, ensure processability
        return (480, 480), 55, "Lowest"


def preprocess_image(
    image_data: str,
    max_size: tuple = None,  # Optional, supports auto-calculation
    quality: int = None,  # Optional, supports auto-calculation
    request_id: Optional[str] = None,
    silent: bool = False,
    image_count: int = 1  # Total image count, for dynamic adjustment
) -> str:
    """
    Preprocess image data (compress and resize)

    Args:
        image_data: Base64-encoded image data
        max_size: Maximum size, defaults to None (auto-calculated)
        quality: JPEG compression quality (1-100), defaults to None (auto-calculated)
        request_id: Request ID, for log output
        silent: Whether to use silent mode (no log output)
        image_count: Total image count, for intelligent optimization in multi-image scenarios

    Returns:
        str: Processed image data
    """
    try:
        # Intelligently calculate optimal parameters
        if max_size is None or quality is None:
            optimal_size, optimal_quality, compression_level = get_optimal_image_params(image_count)
            max_size = max_size or optimal_size
            quality = quality or optimal_quality
        else:
            compression_level = "Custom"

        # Check if it's base64-encoded image data
        if image_data.startswith('data:image'):
            # Extract base64 data
            header, encoded = image_data.split(",", 1)
            image_bytes = base64.b64decode(encoded)
            original_bytes = len(image_bytes)

            # Open image
            img = Image.open(BytesIO(image_bytes))
            original_size = img.size

            # Calculate scaling ratio
            if img.size[0] > max_size[0] or img.size[1] > max_size[1]:
                img.thumbnail(max_size, Image.Resampling.LANCZOS)
            
            # Convert to RGB (if RGBA)
            if img.mode in ('RGBA', 'LA', 'P'):
                background = Image.new('RGB', img.size, (255, 255, 255))
                if img.mode == 'P':
                    img = img.convert('RGBA')
                background.paste(img, mask=img.split()[-1] if img.mode in ('RGBA', 'LA') else None)
                img = background
            
            # Compress image
            buffer = BytesIO()
            img.save(buffer, format="JPEG", quality=quality, optimize=True)
            compressed_bytes = buffer.getvalue()
            compressed_size = len(compressed_bytes)
            
            # Encode to base64
            compressed_b64 = base64.b64encode(compressed_bytes).decode('utf-8')
            processed_image_data = f"data:image/jpeg;base64,{compressed_b64}"

            # Output log
            if not silent:
                compression_ratio = (1 - compressed_size / original_bytes) * 100 if original_bytes > 0 else 0
                
                # Multi-image scenario: show compression level
                if image_count > 1:
                    print(
                        f"{REQUEST_PREFIX} 🟡 Image preprocessing | "
                        f"Size:{original_size}→{img.size} | "
                        f"Data:{original_bytes/1024:.1f}KB→{compressed_size/1024:.1f}KB | "
                        f"Compression:{compression_ratio:.1f}% | "
                        f"Level:{compression_level} ({image_count} frames)"
                    )
                else:
                    print(
                        f"{REQUEST_PREFIX} 🟡 Image preprocessing complete | "
                        f"Size:{original_size}→{img.size} | "
                        f"Data:{original_bytes/1024:.1f}KB→{compressed_size/1024:.1f}KB | "
                        f"Compression:{compression_ratio:.1f}%"
                    )
            
            return processed_image_data
        
        # If not base64-encoded image data, return as-is
        return image_data
    
    except Exception as e:
        if not silent:
            print(f"{WARN_PREFIX} ❌Image preprocessing failed | Request ID:{request_id} | Error:{str(e)}")
        # Return original image data when preprocessing fails
        return image_data


def check_multi_image_support(provider: str, model: str) -> tuple:
    """
    Check if a service provider supports multi-image analysis

    Args:
        provider: Service provider identifier
        model: Model name

    Returns:
        tuple: (supports_multi_image: bool, max_image_count: int)
    """
    model_lower = (model or "").lower()

    # Gemini series: supports multi-image
    if "gemini" in model_lower or "google" in model_lower:
        return (True, 3000)

    # Zhipu GLM series vision models
    # GLM-4.6V series: 128K context, supports large number of images (no official hard limit)
    if "glm" in model_lower and "4.6v" in model_lower:
        return (True, 100)

    # GLM-4V series (4V-Plus etc.): 16K context, max 5 images
    if "glm" in model_lower and ("4v" in model_lower or "vision" in model_lower):
        return (True, 5)

    # Qwen series: supports multi-image
    if "qwen" in model_lower and ("vl" in model_lower or "vision" in model_lower):
        return (True, 100)

    # OpenAI GPT-4V and compatible models: supports multi-image
    if "gpt-4" in model_lower and ("vision" in model_lower or "v" in model_lower or "turbo" in model_lower):
        return (True, 100)

    # Other OpenAI-compatible vision models
    if any(keyword in model_lower for keyword in ["vision", "visual", "vl", "multimodal"]):
        return (True, 10)

    # Default: does not support multi-image
    return (False, 0)
