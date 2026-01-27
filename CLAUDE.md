# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ComfyUI-Prompt-Assistant is a full-stack ComfyUI plugin that provides AI-powered prompt assistance, translation, image/video captioning, and tag management. It integrates multiple LLM/VLM service providers (OpenAI-compatible APIs, Ollama, Baidu Translate) with a unified interface.

**Current Version**: 2.0.2

## Architecture

### Backend (Python)

**Plugin Integration** (`__init__.py`):
- Registers 5 custom node types: ImageCaption, Translate, Expand, KontextPreset, VideoCaption
- Mounts REST API routes via `server.py` import
- Injects version number into frontend via auto-generated `js/version.js`
- Exports `./js` directory for frontend assets

**REST API Layer** (`server.py`):
- 74+ endpoints dynamically mounted at `/{plugin_dir_name}/api/*`
- Route prefix auto-adapts if plugin folder is renamed
- Categories: service management, model CRUD, configuration, AI operations (LLM/VLM), streaming (SSE), video processing
- Global `ACTIVE_TASKS` dict tracks async operations for cancellation support

**Configuration System** (`config_manager.py`):
- User configs stored in `ComfyUI/user/default/prompt-assistant/` (persists across reinstalls)
- Falls back to plugin directory if user directory unavailable
- Atomic writes using temp file + rename pattern to prevent corruption
- Three-tier structure:
  - `config/`: User settings (config.json, active_prompts.json, tags_user.json, tags_selection.json)
  - `rules/`: Prompt templates (system_prompts.json, kontext_presets.json)
  - `tags/`: CSV tag libraries
- Template-based defaults from `config/*_template.json`
- Version migration via `utils/migration_tool.py`

**Service Layer** (`services/`):
```
BaseAPIService (core.py)
    └── OpenAICompatibleService (openai_base.py)
            ├── LLMService (llm.py)
            └── VisionService (vlm.py)
```

**Key Features**:
- **Smart URL parsing**: Handles `/v1` suffix, `#` force mode, endpoint auto-detection
- **3-level degradation retry**: Full request → remove thinking params → minimal payload (ensures API compatibility)
- **Ollama native API**: Smart context window calculation and auto-unload for VRAM management
- **Thinking chain control**: Removes `<think>...</think>` tags and injects provider-specific suppression params
- **HTTP connection pooling**: Persistent connections via `HTTPClientPool`
- **Progress streaming**: Unified `ProgressBar` class with single-line ANSI updates

**Node Layer** (`node/`):
- Base classes: `BaseNode` → `LLMNodeBase` / `VLMNodeBase`
- Async-to-sync bridge with thread-safe execution
- Interrupt detection (ComfyUI flag + custom threading.Event)
- Service/model selection format: `"ServiceName/ModelName"` in dropdowns
- `[R]` trigger in input bypasses `IS_CHANGED` for forced execution

### Frontend (JavaScript)

**Extension Entry** (`js/index.js`):
- Registers ComfyUI extension with lifecycle hooks: `setup()`, `nodeCreated()`, `beforeRegisterNodeDef()`
- Initializes `nodeMountService` for render mode detection (Canvas vs Vue Node 2.0)
- Injects universal hooks for all nodes (onSelected, onRemoved)
- Handles graph switching and workflow loading with cache preservation

**Core Modules** (`js/modules/`):
- **PromptAssistant.js**: Per-node assistant lifecycle (create/attach/cleanup), context menu integration, history management
- **ImageCaption.js**: Image widget detection, direct image analysis with streaming, camera button injection
- **apiConfigManager.js**: Service/model CRUD operations, masked API key handling, drag-and-drop reordering
- **rulesConfigManager.js**: System prompts management, active prompt selection, category-based organization
- **tag.js**: CSV tag loader, multi-level category tree, search/filter, favorites management

**UI Components** (`js/utils/UIToolkit.js`):
- Component library: dialogs, buttons, inputs, selects, collapsible sections, tabs
- Drag-and-drop utilities for reordering
- `AssistantContainer.js`: Floating panel with auto-positioning and collision detection

**State Management**:
- `HistoryCacheService`: Per-node history storage in localStorage
- `TagCacheService`: Tag data caching with version tracking
- `features.js`: Global feature toggles (imageCaption, nodeHelpTranslator, etc.)
- `eventManager.js`: Centralized event bus for module communication

## Key Data Flow Patterns

### Node Execution (Backend)
```
ComfyUI Queue → Node.execute()
  → BaseNode._run_llm_task() / _run_vision_task()
  → Thread + asyncio.new_event_loop()
  → LLMService / VisionService async methods
  → OpenAICompatibleService._http_request_chat_completions()
  → HTTPClientPool (persistent connections)
  → Streaming SSE chunks → ProgressBar updates
  → Return {"success": bool, "data": dict, "error": str}
```

### Frontend Assistant Lifecycle
```
Node Added → onNodeAdded hook
  → _handleNodeActive() checks auto-creation mode
  → PromptAssistant.checkAndSetupNode()
  → Find/create widget → Inject UI → Register events
  → User interaction → API call → Update widget
  → Node Removed → cleanup() → Remove UI/events
```

### Configuration Sync
```
Frontend UI Change
  → apiConfigManager.updateService()
  → PUT /api/services/{id}
  → config_manager.update_service()
  → Atomic write to config.json
  → Backend reloads config on next request
```

## Development Guidelines

### Working with Services

**Adding a new AI service provider**:
1. No code changes needed - services are fully configurable via UI
2. Access Settings → API Configuration → Add Service
3. Provide: name, base_url, api_key, model list
4. Service automatically appears in node dropdowns

**Modifying service logic**:
- Core logic in `services/openai_base.py`
- Provider-specific behavior in `services/thinking_control.py`
- Ollama native API in `services/llm.py` and `services/vlm.py`

### Working with Nodes

**Node structure**:
- Inherit from `LLMNodeBase` or `VLMNodeBase`
- Define `INPUT_TYPES()` classmethod with service/model selectors
- Implement `execute()` with `self._run_llm_task()` or `self._run_vision_task()`
- Register in `node/__init__.py` exports

**Service/model selection**:
- Use `self.get_service_options()` and `self.get_model_options()` in `INPUT_TYPES`
- Format: `[("ServiceName/ModelName", "ServiceName/ModelName"), ...]`
- Parse selection in execute: `service_id, model_id = self._parse_service_model_input(service_model_input)`

### Working with Frontend

**Adding UI features**:
- Create module in `js/modules/`
- Import and initialize in `js/index.js`
- Use `UIToolkit.js` components for consistent styling
- Register settings in `settings.js` for user control

**Accessing APIs from frontend**:
- Base URL: `/${pluginDirName}/api`
- Use `fetch()` or `EventSource()` for streaming endpoints
- Check `js/services/api.js` for existing helpers

### Configuration Management

**Reading configuration**:
```python
from config_manager import config_manager
config = config_manager.get_config()
services = config_manager.get_all_services()
```

**Writing configuration**:
```python
config_manager.update_service(service_id, service_data)
config_manager.set_active_prompt("expand", "expand_expand-general")
```

**Adding new config options**:
1. Update `config/config_template.json` with new field and default value
2. Increment `__config_version` in template
3. Add migration logic in `utils/migration_tool.py` if needed
4. Update `config_manager.py` getter/setter methods

### Tag System

**CSV format**:
```csv
Category,SubCategory,Name,Content
人物,动作,跑步,running
场景,室内,卧室,bedroom
```

**Multi-encoding support**: utf-8-sig, gbk, gb18030 auto-detected
**Location**: `ComfyUI/user/default/prompt-assistant/tags/*.csv`

### Translation Work

**Recent translation effort**:
- Frontend UI strings and comments translated from Chinese to English (batches 4-7)
- Python files partially translated
- Check `.claude/` directory for translation work summary
- Some Chinese text remains in README.md (intentionally bilingual)

## Common Patterns

### Async-to-Sync Bridge in Nodes
```python
def execute(self):
    result = self._run_llm_task(
        self._async_execute,
        param1, param2
    )
    return result

async def _async_execute(self, param1, param2):
    # Async implementation
    pass
```

### Streaming Progress
**Backend**:
```python
from utils.common import ProgressBar, TASK_TRANSLATE
progress = ProgressBar(total_chars, task_type=TASK_TRANSLATE)
progress.start()
progress.update(current_chars)
progress.finish(result_text)
```

**Frontend**:
```javascript
const eventSource = new EventSource(`/api/llm/expand/stream`);
eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'progress') updateProgress(data);
    if (data.type === 'done') handleResult(data);
};
```

### Error Handling
All service methods return:
```python
{
    "success": bool,
    "data": dict,  # Results on success
    "error": str   # Error message on failure
}
```

Check `result["success"]` before accessing `result["data"]`.

## Testing

**Manual testing approach**:
1. Create test workflows with nodes
2. Test with multiple service providers
3. Check console logs for errors (both ComfyUI terminal and browser DevTools)
4. Verify configuration persistence after restart

**No automated test suite currently exists.**

## Important Notes

- **API Keys**: Stored in plaintext in `config.json` (masked in frontend responses)
- **User Data Location**: `ComfyUI/user/default/prompt-assistant/` (survives plugin reinstalls)
- **Plugin Directory Name**: Can be renamed - routes auto-adapt via `NODE_DIR_NAME`
- **Node 2.0 Support**: Full support for ComfyUI's Vue-based Node 2.0 rendering mode
- **Interrupt Handling**: All long-running operations check for ComfyUI's interrupt flag
- **Ollama VRAM**: Auto-unload feature prevents VRAM leaks (configurable per node)
