
import os
import re
from server import PromptServer
from . import server
from .node.translate_node import NODE_CLASS_MAPPINGS as TRANSLATE_NODE_CLASS_MAPPINGS
from .node.translate_node import NODE_DISPLAY_NAME_MAPPINGS as TRANSLATE_NODE_DISPLAY_NAME_MAPPINGS
from .node.image_caption_node import NODE_CLASS_MAPPINGS as IMAGE_CAPTION_NODE_CLASS_MAPPINGS
from .node.image_caption_node import NODE_DISPLAY_NAME_MAPPINGS as IMAGE_CAPTION_NODE_DISPLAY_NAME_MAPPINGS
from .node.kontext_preset_node import NODE_CLASS_MAPPINGS as KONTEXT_PRESET_NODE_CLASS_MAPPINGS
from .node.kontext_preset_node import NODE_DISPLAY_NAME_MAPPINGS as KONTEXT_PRESET_NODE_DISPLAY_NAME_MAPPINGS
from .node.expand_node import NODE_CLASS_MAPPINGS as EXPAND_NODE_CLASS_MAPPINGS
from .node.expand_node import NODE_DISPLAY_NAME_MAPPINGS as EXPAND_NODE_DISPLAY_NAME_MAPPINGS
from .node.video_caption_node import NODE_CLASS_MAPPINGS as VIDEO_CAPTION_NODE_CLASS_MAPPINGS
from .node.video_caption_node import NODE_DISPLAY_NAME_MAPPINGS as VIDEO_CAPTION_NODE_DISPLAY_NAME_MAPPINGS

# Module constant definitions
NODE_CLASS_MAPPINGS = {
    **IMAGE_CAPTION_NODE_CLASS_MAPPINGS,
    **KONTEXT_PRESET_NODE_CLASS_MAPPINGS,
    **TRANSLATE_NODE_CLASS_MAPPINGS,
    **EXPAND_NODE_CLASS_MAPPINGS,
    **VIDEO_CAPTION_NODE_CLASS_MAPPINGS,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    **IMAGE_CAPTION_NODE_DISPLAY_NAME_MAPPINGS,
    **KONTEXT_PRESET_NODE_DISPLAY_NAME_MAPPINGS,
    **TRANSLATE_NODE_DISPLAY_NAME_MAPPINGS,
    **EXPAND_NODE_DISPLAY_NAME_MAPPINGS,
    **VIDEO_CAPTION_NODE_DISPLAY_NAME_MAPPINGS,
}
WEB_DIRECTORY = "./js"

# Update node mappings
NODE_CLASS_MAPPINGS.update(TRANSLATE_NODE_CLASS_MAPPINGS)
NODE_DISPLAY_NAME_MAPPINGS.update(TRANSLATE_NODE_DISPLAY_NAME_MAPPINGS)

def get_version():
    """
    Read version number from pyproject.toml file

    Returns:
        str: Version number string

    Raises:
        ValueError: Raised when version number cannot be found
    """
    try:
        toml_path = os.path.join(os.path.dirname(__file__), "pyproject.toml")
        with open(toml_path, "r", encoding='utf-8') as f:
            content = f.read()
            version_match = re.search(r'version\s*=\s*"([^"]+)"', content)
            if version_match:
                return version_match.group(1)
            raise ValueError("Version number not found in pyproject.toml")
    except Exception as e:
        print(f"Failed to read version number: {str(e)}")
        raise

def inject_version_to_frontend():
    """
    Inject version number into frontend global variable
    """
    js_code = f"""
window.PromptAssistant_Version = "{VERSION}";
    """
    
    js_dir = os.path.join(os.path.dirname(__file__), "js")
    if not os.path.exists(js_dir):
        os.makedirs(js_dir)
    
    version_file = os.path.join(js_dir, "version.js")
    with open(version_file, "w", encoding='utf-8') as f:
        f.write(js_code)

# Initialize version number
VERSION = get_version()

# Execute initialization
inject_version_to_frontend()

# Disable httpx verbose logging to avoid interrupting single-line dynamic display
import logging
logging.getLogger("httpx").setLevel(logging.WARNING)

# Print initialization info
print(f"✨Prompt Assistant V{VERSION} started")



