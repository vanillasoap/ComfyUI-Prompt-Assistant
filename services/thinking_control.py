"""
Thinking chain control module - Refactored version
Unified management of thinking chain/reasoning mode disable parameters for various models

Design principles:
- Match by model features, not by provider (except Ollama, which uses native API)
- Group by parameter type, not by provider
- Support mainstream platforms: Zhipu/Qwen/DeepSeek/Gemini/Grok/Ollama
- Retain 400 error auto-degradation mechanism (in openai_base.py)
"""

import re
from typing import Dict, Any, List


# ==================== Level 1: Generic model rules (provider-agnostic) ====================
# Grouped by parameter type, matched by iteration

THINKING_CONTROL_RULES: List[Dict[str, Any]] = [
    {
        "name": "zhipu_glm",
        "description": "Zhipu GLM-4.5/4.6 series",
        "patterns": [r"glm[-_/.]?4\.(5|6)"],
        "params": {"thinking": {"type": "disabled"}},
        "sources": ["Zhipu Official API", "Various aggregation platforms"]
    },
    {
        "name": "qwen3_enable_thinking",
        "description": "Qwen3 series (platforms supporting enable_thinking)",
        "patterns": [
            r"qwen[-_/.]?3(?!.*thinking)(?!.*r1)",  # Qwen3 non-thinking/r1 variants
            r"qwen.*[-_/.]?vl",  # Qwen-VL series (including qwen2/qwen3-vl)
        ],
        "params": {"enable_thinking": False},
        "sources": ["ModelScope", "Alibaba Bailian", "SiliconFlow"]
    },
    {
        "name": "qwen_deepseek_reasoning",
        "description": "Qwen/DeepSeek reasoning models (R1 series)",
        "patterns": [
            r"qwen.*[-_/.]?(r1|thinking)",  # Qwen reasoning models
            r"deepseek.*[-_/.]?(r1|reason)",  # DeepSeek R1 series
        ],
        "params": {"reasoning": {"effort": "none"}},
        "sources": ["OpenRouter", "302.ai", "Other aggregation platforms"]
    },
    {
        "name": "deepseek_v3_thinking",
        "description": "DeepSeek V3/V3.2 Official API",
        "patterns": [
            r"deepseek[-_/.]?v3(\.1|\.2)?(?!.*r1)",  # V3 series non-R1
            r"deepseek[-_/.]?chat",  # DeepSeek Chat
        ],
        "params": {"thinking": {"type": "disabled"}},
        "sources": ["DeepSeek Official API"],
        "notes": "Can also be controlled via /thinking suffix in model name"
    },
    {
        "name": "gemini2_reasoning",
        "description": "Gemini 2.0/2.5 Flash/Lite",
        "patterns": [r"gemini[-_/.]?2\.(0|5)[-_/.]?(flash|lite)"],
        "params": {"reasoning_effort": "none"},
        "sources": ["Google Official API", "OpenAI-compatible endpoint"]
    },
    {
        "name": "gemini3_thinking",
        "description": "Gemini 3.0 series (controlled via reasoning_effort)",
        "patterns": [r"gemini[-_/.]?3"],
        "params": {"reasoning_effort": "low"},
        "sources": ["Google Official API (OpenAI-compatible endpoint)"],
        "notes": "⚠️ Official OpenAI endpoint uses reasoning_effort parameter"
    },
    {
        "name": "grok3_mini_reasoning",
        "description": "Grok-3-mini (supports reasoning_effort)",
        "patterns": [r"grok[-_/.]?3[-_/.]?mini"],
        "params": {"reasoning_effort": "low"},
        "sources": ["xAI Official API"]
    },
    # Note: Grok-4 series are built-in reasoning models, do not support reasoning_effort parameter, handled in exclude rules
]


# ==================== Level 2: Ollama special rules (native API only) ====================
# Ollama uses /api/chat native endpoint, parameter format differs
#
# ⚠️ Important finding: think parameter behavior is counter-intuitive
# - think: true  -> Disable thinking (do not output <think> tags)
# - think: false -> Enable thinking (output <think> tags)
# - Not sent     -> Default disable thinking (Ollama default behavior)

OLLAMA_NATIVE_RULES = {
    "parameter_name": "think",
    "disable_value": True,   # Send this value when disable_thinking=True (disable thinking)
    "enable_value": False,   # Send this value when disable_thinking=False (enable thinking)
    "supported_patterns": [
        # r"qwen",  # Removed: too broad, would incorrectly match qwen-instruct and other standard models
        r"deepseek.*r1",  # DeepSeek R1 series
        r"qwen.*r1",      # Qwen R1 variants
        r".*thinking",    # Any model with "thinking" in name
    ],
    "notes": "Ollama native API /api/chat top-level parameter"
}


# ==================== Level 3: Exclude rules (models that explicitly don't support disabling) ====================
# These models either don't support disabling reasoning, or are built-in reasoning models

EXCLUDE_PATTERNS = [
    r"gemini[-_/.]?2\.5[-_/.]?pro",  # Gemini 2.5 Pro officially does not support disabling
    r"grok[-_/.]?4",  # Grok-4 series are built-in reasoning models, no reasoning_effort parameter
    r".*speciale",  # DeepSeek Speciale is thinking-only mode
]


# ==================== Core matching function ====================

def build_thinking_suppression(provider: str, model: str, disable_thinking: bool = True) -> Dict[str, Any]:
    """
    Return thinking chain control parameters based on model features

    Matching priority:
    1. Check exclude rules -> return empty dict (models that explicitly don't support it)
    2. Ollama special handling -> native API parameter format
    3. Iterate generic rules -> return first matching parameters
    4. No match -> return empty dict

    Args:
        provider: Provider identifier (only used for Ollama detection, other providers ignored)
        model: Model name
        disable_thinking: True=disable thinking, False=enable thinking

    Returns:
        Dict: Thinking chain control parameter dict, or empty dict

    Examples:
        >>> build_thinking_suppression("ollama", "qwen3-thinking", disable_thinking=True)
        {"think": True}  # Disable thinking

        >>> build_thinking_suppression("ollama", "qwen3-thinking", disable_thinking=False)
        {"think": False}  # Enable thinking

        >>> build_thinking_suppression("zhipu", "glm-4.5")
        {"thinking": {"type": "disabled"}}

        >>> build_thinking_suppression("custom", "gemini-2.5-pro")
        {}  # Does not support disabling
    """
    if not model:
        return {}
    
    model_lower = model.strip().lower()
    provider_lower = provider.strip().lower() if provider else ""
    
    # 1. Check exclude rules
    for exclude_pattern in EXCLUDE_PATTERNS:
        if re.search(exclude_pattern, model_lower):
            return {}  # Model explicitly not supported, return empty dict

    # 2. Ollama special handling (native API)
    if provider_lower == "ollama":
        for pattern in OLLAMA_NATIVE_RULES["supported_patterns"]:
            if re.search(pattern, model_lower):
                # Select value based on disable_thinking parameter
                think_value = OLLAMA_NATIVE_RULES["disable_value"] if disable_thinking else OLLAMA_NATIVE_RULES["enable_value"]
                return {
                    OLLAMA_NATIVE_RULES["parameter_name"]: think_value
                }
        return {}  # Ollama but not in whitelist

    # 3. Iterate generic rules, return first match
    for rule in THINKING_CONTROL_RULES:
        for pattern in rule["patterns"]:
            if re.search(pattern, model_lower):
                # Return copy to avoid modifying original data
                return rule["params"].copy()

    # 4. No match, return empty dict
    return {}


# ==================== Helper functions (for debugging) ====================

def get_rule_info(provider: str, model: str) -> Dict[str, Any]:
    """
    Get detailed information about matched rules (for debugging)

    Returns:
        Dict: {
            "matched": bool,
            "rule_name": str,
            "description": str,
            "params": Dict,
            "sources": List[str]
        }
    """
    if not model:
        return {"matched": False}
    
    model_lower = model.strip().lower()
    provider_lower = provider.strip().lower() if provider else ""
    
    # Check exclude rules
    for exclude_pattern in EXCLUDE_PATTERNS:
        if re.search(exclude_pattern, model_lower):
            return {
                "matched": True,
                "rule_name": "EXCLUDED",
                "description": "Model that explicitly does not support disabling thinking chain",
                "params": {},
                "sources": []
            }

    # Ollama special handling
    if provider_lower == "ollama":
        for pattern in OLLAMA_NATIVE_RULES["supported_patterns"]:
            if re.search(pattern, model_lower):
                return {
                    "matched": True,
                    "rule_name": "ollama_native",
                    "description": "Ollama native API",
                    "params": {
                        OLLAMA_NATIVE_RULES["parameter_name"]: 
                        OLLAMA_NATIVE_RULES["parameter_value"]
                    },
                    "sources": ["Ollama /api/chat"]
                }
        return {"matched": False}
    
    # Generic rules
    for rule in THINKING_CONTROL_RULES:
        for pattern in rule["patterns"]:
            if re.search(pattern, model_lower):
                return {
                    "matched": True,
                    "rule_name": rule["name"],
                    "description": rule["description"],
                    "params": rule["params"].copy(),
                    "sources": rule.get("sources", [])
                }
    
    return {"matched": False}
