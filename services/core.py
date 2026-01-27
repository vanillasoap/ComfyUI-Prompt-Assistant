"""
Core infrastructure module
Provides HTTP client pool management
"""

import httpx
import os
from typing import Dict, Optional, Any
import re


class HTTPClientPool:
    """
    HTTP client pool
    Manages persistent httpx.AsyncClient instances, supporting connection reuse
    """
    _clients: Dict[str, httpx.AsyncClient] = {}
    _loop_id: Optional[int] = None  # Record the event loop ID when clients were created
    
    @classmethod
    def _check_loop_change(cls) -> bool:
        """
        Detect if the event loop has changed.
        Returns: True = loop has changed, old clients need to be cleaned up
        """
        try:
            import asyncio
            current_loop = asyncio.get_running_loop()
            current_loop_id = id(current_loop)
            
            if cls._loop_id is None:
                cls._loop_id = current_loop_id
                return False
            
            if cls._loop_id != current_loop_id:
                # Event loop has changed, clean up all old clients
                cls._loop_id = current_loop_id
                # Cannot await close, discard references (let GC handle it)
                cls._clients.clear()
                return True
            
            return False
        except RuntimeError:
            # No running event loop, handle conservatively
            return False
    
    @classmethod
    def get_client(
        cls,
        provider: str,
        base_url: Optional[str] = None,
        timeout: float = 60.0,
        proxy: Optional[str] = None,
        verify_ssl: bool = True,
        **kwargs
    ) -> httpx.AsyncClient:
        """
        Get or create an HTTP client (supports connection reuse)

        Args:
            provider: Provider identifier (used for logging)
            base_url: API base URL, used as cache key
            timeout: Timeout in seconds
            proxy: Proxy settings
            verify_ssl: Whether to verify SSL certificates
        """
        # Detect event loop changes, clean up old clients if necessary
        cls._check_loop_change()
        
        # Use base_url as unique identifier for caching
        cache_key = base_url or provider
        
        if cache_key in cls._clients:
            client = cls._clients[cache_key]
            if not client.is_closed:
                return client

        # Create new client
        client_kwargs = {
            'timeout': httpx.Timeout(timeout, connect=10.0, read=timeout, write=60.0),
            'verify': verify_ssl,
            'follow_redirects': True,
            'http2': False,
            # Set connection pool keep-alive
            'limits': httpx.Limits(max_keepalive_connections=10, max_connections=20, keepalive_expiry=60.0)
        }
        
        if proxy:
            client_kwargs['proxies'] = proxy
        
        client_kwargs.update(kwargs)
        
        client = httpx.AsyncClient(**client_kwargs)
        cls._clients[cache_key] = client
        
        return client

    
    @classmethod
    async def close_all(cls):
        """Close all created clients, fully releasing resources"""
        for key in list(cls._clients.keys()):
            client = cls._clients.pop(key)
            try:
                await client.aclose()
            except:
                pass


# Logger class has been removed. Please import log_prepare, log_complete, log_error and other functions directly from ..utils.common.



class BaseAPIService:
    """
    Abstract base class for API services
    Base for all services (LLM, VLM, Baidu)
    """
    
    def __init__(self, http_client_pool: HTTPClientPool = None):
        """
        Initialize base class

        Args:
            http_client_pool: HTTP client pool (optional, defaults to global pool)
        """
        self.http_client_pool = http_client_pool or HTTPClientPool
    
    def get_config(self) -> Dict[str, Any]:
        """
        Get service configuration (subclasses must implement)

        Returns:
            Dict: Configuration dictionary
        """
        raise NotImplementedError("Subclasses must implement the get_config method")
    
    async def handle_error(self, error: Exception, provider: str) -> Dict[str, Any]:
        """
        Unified error handling

        Args:
            error: Exception object
            provider: Provider identifier

        Returns:
            Dict: Error response
        """
        from ..utils.common import format_api_error
        error_message = format_api_error(error, provider)
        return {
            "success": False,
            "error": error_message
        }
