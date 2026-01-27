import os
import json
import csv
import tempfile
import shutil
import folder_paths

class ConfigManager:
    def __init__(self):
        # Plugin directory
        self.dir_path = os.path.dirname(os.path.abspath(__file__))
        
        # Get ComfyUI user directory
        try:
            user_dir = folder_paths.get_user_directory()
            if user_dir and os.path.isdir(user_dir):
                # Use user/default/prompt-assistant as base directory
                self.base_dir = os.path.join(user_dir, "default", "prompt-assistant")
                # self._log(f"Using user config directory: {self.base_dir}")
            else:
                # Fall back to plugin directory
                self.base_dir = self.dir_path
                self._log(f"Falling back to plugin config directory: {self.base_dir}")
        except Exception as e:
            # Exception handling, fall back to plugin directory
            self.base_dir = self.dir_path
            self._log(f"Unable to get user directory ({str(e)}), using plugin config directory")
        
        # Define subdirectories
        self.config_dir = os.path.join(self.base_dir, "config")
        self.rules_dir = os.path.join(self.base_dir, "rules")
        self.tags_dir = os.path.join(self.base_dir, "tags")
        
        # Ensure directories exist
        os.makedirs(self.config_dir, exist_ok=True)
        os.makedirs(self.rules_dir, exist_ok=True)
        os.makedirs(self.tags_dir, exist_ok=True)

        # Config file paths (user configuration and selection)
        self.config_path = os.path.join(self.config_dir, "config.json")
        self.active_prompts_path = os.path.join(self.config_dir, "active_prompts.json")
        self.tags_user_path = os.path.join(self.config_dir, "tags_user.json")
        self.tags_selection_path = os.path.join(self.config_dir, "tags_selection.json")
        
        # Rules file paths (rule definitions and templates)
        self.system_prompts_path = os.path.join(self.rules_dir, "system_prompts.json")
        self.kontext_presets_path = os.path.join(self.rules_dir, "kontext_presets.json")

        # ---Template directory (built-in to plugin)---
        self.templates_dir = os.path.join(self.dir_path, "config")
        
        # Store template version numbers (for version comparison)
        self._template_versions = {}

        # ---Load default configurations (from template files)---
        self.default_config = self._load_template("config", {"version": "2.0", "model_services": []})
        self.default_system_prompts = self._load_template("system_prompts", {})
        self.default_kontext_presets = self._load_template("kontext_presets", {})
        
        # ---Simple default configurations (no template needed, defined directly)---
        self.default_active_prompts = {
            "expand": "expand_扩写-通用",
            "vision_zh": "vision_zh_图像描述-Tag风格",
            "vision_en": "vision_en_Detail_Caption"
        }
        self.default_user_tags = {"favorites": []}
        
        # Default tag selection
        self.default_tags_selection = {"selected_file": "用户标签.csv"}



        # Execute data migration and config file initialization
        # migration_tool handles uniformly: ensure files exist -> CSV tag migration -> legacy migration -> incremental update
        self._run_migrations()

        # Validate and fix active prompts (silent mode, fix only on exceptions)
        self.validate_and_fix_active_prompts()

        # Validate and fix model parameter configuration
        self.validate_and_fix_model_params()

    # --- Data Migration ---
    def _run_migrations(self):
        """
        Execute data migration (called on demand, does not affect performance)
        Only imports and runs the migration tool when needed
        """
        try:
            from .utils.migration_tool import run_migrations

            # Prepare default config data for incremental updates
            default_configs = {
                'config': self.default_config,
                'system_prompts': self.default_system_prompts,
                'active_prompts': self.default_active_prompts,
                'tags_user': self.default_user_tags,
                'kontext_presets': self.default_kontext_presets
            }
            
            # Run migrations
            results = run_migrations(
                plugin_dir=self.dir_path,
                user_base_dir=self.base_dir,
                logger=self._log,
                default_configs=default_configs
            )
            
            # Record migration results
            if results.get('tags_migration'):
                self._log("[user_tags.csv] Data migration complete")

        except Exception as e:
            self._log(f"Data migration failed: {str(e)}")
            # Migration failure does not affect normal operation, only log it

    # --- Unified Log Output ---
    def _log(self, msg: str):
        """Unified console log prefix"""
        from .utils.common import _ANSI_CLEAR_EOL
        print(f"\r{_ANSI_CLEAR_EOL}✨ {msg}", flush=True)

    # ---Template Loading---
    def _load_template(self, template_name: str, fallback: dict = None) -> dict:
        """
        Load default configuration from template file

        Args:
            template_name: Template name (without extension and _template suffix)
            fallback: Fallback default value on load failure

        Returns:
            Configuration dictionary (contains __config_version for version management)
        """
        template_path = os.path.join(self.templates_dir, f"{template_name}_template.json")
        try:
            with open(template_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                # Get version number and save for later comparison
                template_version = data.get("__config_version", "2.0")
                self._template_versions[template_name] = template_version
                return data
        except Exception as e:
            self._log(f"Failed to load template {template_name}: {str(e)}, using fallback value")
            # Ensure fallback also contains version number
            if fallback is None:
                fallback = {}
            # If fallback has no version number, add default version number
            if "__config_version" not in fallback:
                fallback = {"__config_version": "2.0", **fallback}
            self._template_versions[template_name] = "2.0"
            return fallback

    def _get_config_version(self, config: dict) -> str:
        """
        Get config version number (compatible with both old and new version fields)

        Version field priority:
        1. __config_version (new version field, e.g. "2.0.0")
        2. version (old version field, e.g. "2.0" or "1.0")
        3. Default returns "1.0" (no version field is treated as oldest version)

        Returns:
            Version string, e.g. "2.0.0", "2.0" or "1.0"
        """
        # Prefer new version field
        if "__config_version" in config:
            return config["__config_version"]
        # Compatible with old version field
        return config.get("version", "1.0")

    def _is_v2_config(self, config: dict) -> bool:
        """
        Check if config is v2.0 or higher version

        Returns:
        True indicates v2.0 or higher (1.9 is also treated as v2 format, for incremental testing)
        """
        version = self._get_config_version(config)
        try:
            v_float = float(version)
            return v_float >= 1.9
        except ValueError:
            # If not a number (e.g. "2.0.0"), compare major version number
            major_version = version.split(".")[0]
            try:
                return int(major_version) >= 2
            except ValueError:
                return False

    # --- Note: The following methods have been migrated to migration_tool.py ---
    # - _apply_migrated_api_keys
    # - _migrate_provider_to_service
    # - _create_or_update_custom_service
    # - _match_service_by_provider
    # - _check_and_add_missing_services
    # Config file creation, migration and incremental updates are handled uniformly by migration_tool


    def _atomic_write_json(self, file_path: str, data: dict) -> bool:
        """
        Atomically write JSON file

        Uses "write to temp file + atomic rename" strategy to ensure atomic file writing:
        - If write succeeds, the new file replaces the old file
        - If write fails or is interrupted, the old file remains unchanged

        Args:
            file_path: Target file path
            data: Data dictionary to save

        Returns:
            bool: True if save succeeded, False if failed
        """
        temp_fd = None
        temp_path = None
        
        try:
            # ---Step 1: Write to temp file---
            # Create temp file in same directory (ensures same filesystem, so rename is atomic)
            temp_fd, temp_path = tempfile.mkstemp(
                dir=os.path.dirname(file_path),
                suffix='.tmp',
                prefix='.tmp_'
            )
            
            # Write complete new config to temp file
            with os.fdopen(temp_fd, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
                temp_fd = None  # File already closed, avoid double close

            # ---Step 2: Atomic replacement---
            # rename operation is atomic, either succeeds completely or fails without change
            shutil.move(temp_path, file_path)
            temp_path = None  # Already moved, avoid cleanup deletion
            
            return True
            
        except Exception as e:
            self._log(f"Atomic JSON file write failed [{os.path.basename(file_path)}]: {str(e)}")
            return False
            
        finally:
            # Clean up temp file (if write failed)
            if temp_fd is not None:
                try:
                    os.close(temp_fd)
                except:
                    pass
            
            if temp_path is not None and os.path.exists(temp_path):
                try:
                    os.unlink(temp_path)
                except:
                    pass

    def load_config(self):
        """Load configuration file"""
        try:
            with open(self.config_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            self._log(f"Failed to load config file: {str(e)}")
            return self.default_config

    def save_config(self, config):
        """Save configuration file"""
        return self._atomic_write_json(self.config_path, config)

    def load_system_prompts(self):
        """Load system prompts configuration"""
        try:
            with open(self.system_prompts_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            self._log(f"Failed to load system prompts config: {str(e)}")
            return self.default_system_prompts

    def save_system_prompts(self, system_prompts):
        """Save system prompts configuration"""
        return self._atomic_write_json(self.system_prompts_path, system_prompts)

    def load_active_prompts(self):
        """Load active prompts configuration"""
        try:
            with open(self.active_prompts_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            self._log(f"Failed to load active prompts config: {str(e)}")
            return self.default_active_prompts

    def save_active_prompts(self, active_prompts):
        """Save active prompts configuration"""
        return self._atomic_write_json(self.active_prompts_path, active_prompts)

    def load_user_tags(self):
        """Load user tags configuration"""
        try:
            with open(self.tags_user_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            self._log(f"Failed to load user tags config: {str(e)}")
            return self.default_user_tags

    def save_user_tags(self, user_tags):
        """Save user tags configuration"""
        return self._atomic_write_json(self.tags_user_path, user_tags)

    def load_kontext_presets(self):
        """Load Kontext presets configuration"""
        try:
            with open(self.kontext_presets_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            self._log(f"Failed to load Kontext presets config: {str(e)}")
            return {}

    def save_kontext_presets(self, kontext_presets):
        """Save Kontext presets configuration"""
        return self._atomic_write_json(self.kontext_presets_path, kontext_presets)



    # --- Note: ensure_tags_csv_exists and CSV tag migration have been moved to migration_tool.py ---



    def list_tags_files(self) -> list:
        """List all CSV files in the tags directory"""
        try:
            files = []
            for filename in os.listdir(self.tags_dir):
                if filename.endswith(".csv"):
                    files.append(filename)
            return sorted(files)
        except Exception as e:
            self._log(f"Failed to list tag files: {str(e)}")
            return []

    def load_tags_csv(self, filename: str) -> dict:
        """Load CSV tag file, return nested dictionary structure"""
        csv_path = os.path.join(self.tags_dir, filename)
        if not os.path.exists(csv_path):
            self._log(f"CSV file does not exist: {filename}")
            return {}

        # Try multiple encodings, prefer utf-8-sig (Excel default UTF-8), then gbk (Excel default ANSI), finally utf-8
        encodings = ['utf-8-sig', 'gbk', 'gb18030', 'utf-8']
        
        for encoding in encodings:
            try:
                result = {}
                with open(csv_path, "r", encoding=encoding, newline="") as f:
                    reader = csv.reader(f)
                    try:
                        header = next(reader, None)  # Skip header
                    except StopIteration:
                        return {} # Empty file
                    
                    for row in reader:
                        # Filter invalid rows
                        if not row or not any(cell.strip() for cell in row):
                            continue

                        # Need at least two columns: tag name, tag value
                        if len(row) < 2:
                            continue
                        
                        tag_name = row[0].strip()
                        tag_value = row[1].strip()
                        
                        if not tag_name:
                            continue
                            
                        # Category path: starting from column 3, filter empty values
                        categories = [c.strip() for c in row[2:] if c.strip()]
                        
                        # Build nested structure
                        current = result
                        for cat in categories:
                            if cat not in current or not isinstance(current[cat], dict):
                                current[cat] = {}
                            current = current[cat]
                        
                        # Handle empty category placeholder: only create category structure, don't add tags
                        if tag_name == "__empty__" or tag_name == "__placeholder__":
                            continue
                        
                        # Add tag
                        current[tag_name] = tag_value
                
                return result
            except UnicodeDecodeError:
                continue
            except Exception as e:
                self._log(f"Failed to load CSV tags ({encoding}): {str(e)}")
                continue

        self._log(f"Unable to load CSV file: {filename}, all encoding attempts failed")
        return {}

    def save_tags_csv(self, filename: str, tags: dict) -> bool:
        """Save tag data to CSV file"""
        csv_path = os.path.join(self.tags_dir, filename)
        
        try:
            rows = []
            max_depth = 0
            
            def extract_tags(obj, path: list):
                nonlocal max_depth
                # Ensure obj is a dict type
                if not isinstance(obj, dict):
                    return
                
                # If it's an empty category (empty dict), add placeholder row
                if len(obj) == 0 and path:
                    # Use __empty__ as placeholder to mark empty category
                    rows.append(["__empty__", ""] + path)
                    max_depth = max(max_depth, len(path))
                    return
                
                for key, value in obj.items():
                    if isinstance(value, str):
                        rows.append([key, value] + path)
                        max_depth = max(max_depth, len(path))
                    elif isinstance(value, dict):
                        extract_tags(value, path + [key])
            
            # Extract all tags
            extract_tags(tags, [])

            if not rows:
                self._log(f"Save CSV tags: data is empty")
                # If data is empty, write header-only file or keep as is?
                # To prevent accidental deletion, if tags is empty, don't operate or clear the file.
                # Here we choose to write header only:
                with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
                    writer = csv.writer(f)
                    writer.writerow(["Tag Name", "Tag Value"])
                return True

            # Dynamically build header
            header = ["Tag Name", "Tag Value"]
            for i in range(max_depth):
                header.append(f"Category Level {i + 1}")
            
            with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
                writer = csv.writer(f)
                writer.writerow(header)
                for row in rows:
                    # Pad length to match header
                    while len(row) < len(header):
                        row.append("")
                    # Ensure row length does not exceed header (defensive)
                    writer.writerow(row[:len(header)])
            
            return True
        except Exception as e:
            self._log(f"Failed to save CSV tags: {str(e)}")
            return False

    def get_tags_selection(self) -> dict:
        """Get user-selected tag file"""
        try:
            if os.path.exists(self.tags_selection_path):
                with open(self.tags_selection_path, "r", encoding="utf-8") as f:
                    return json.load(f)
            return self.default_tags_selection
        except Exception as e:
            self._log(f"Failed to read tag selection: {str(e)}")
            return self.default_tags_selection

    def save_tags_selection(self, selection: dict) -> bool:
        """Save user-selected tag file"""
        try:
            with open(self.tags_selection_path, "w", encoding="utf-8") as f:
                json.dump(selection, f, ensure_ascii=False, indent=2)
            return True
        except Exception as e:
            self._log(f"Failed to save tag selection: {str(e)}")
            return False

    def get_favorites(self) -> dict:
        """Get favorites list"""
        user_tags = self.load_user_tags()
        favorites = user_tags.get("favorites", {})

        # Compatibility handling: if it's a list, convert to dictionary
        if isinstance(favorites, list):
            new_favorites = {}
            for item in favorites:
                if isinstance(item, str):
                    new_favorites[item] = item
                elif isinstance(item, dict):
                    name = item.get("name", item.get("value"))
                    value = item.get("value")
                    if name and value:
                        new_favorites[name] = value
            return new_favorites
            
        return favorites

    def add_favorite(self, tag_value: str, tag_name: str = None, category: str = "默认") -> bool:
        """Add a favorite"""
        try:
            user_tags = self.load_user_tags()
            favorites = user_tags.get("favorites", {})

            # Compatibility migration: if it's a flat dict {name: value}, no forced migration needed, but newly added items go into category
            # If it's a list, migrate to dictionary first
            if isinstance(favorites, list):
                favorites = self.get_favorites()
                
            name = tag_name if tag_name else tag_value
            
            # Use nested structure {category: {name: value}}
            if category not in favorites:
                # Check if old flat structure exists; if so and category is default, may be mixed
                # Simple handling here: if favorites only has key-value pairs that are all non-dict, it's old flat format
                # To avoid breaking old data, we only store category dicts at top level
                # If favorites already has non-dict values, it's old flat structure {name: value}
                # We move them to the default category
                has_legacy = any(not isinstance(v, dict) for v in favorites.values())
                if has_legacy:
                    legacy_items = {k: v for k, v in favorites.items() if not isinstance(v, dict)}
                    # Clear old items
                    for k in legacy_items:
                        del favorites[k]
                    # Initialize default category
                    if "默认" not in favorites:
                        favorites["默认"] = {}
                    favorites["默认"].update(legacy_items)
                
                if category not in favorites:
                    favorites[category] = {}

            # If favorites[category] is not a dict (defensive programming), initialize as dict
            if not isinstance(favorites.get(category), dict):
                favorites[category] = {}

            favorites[category][name] = tag_value
            
            user_tags["favorites"] = favorites
            return self.save_user_tags(user_tags)
        except Exception as e:
            self._log(f"Failed to add favorite: {str(e)}")
            return False

    def remove_favorite(self, tag_value: str, category: str = None) -> bool:
        """Remove a favorite"""
        try:
            user_tags = self.load_user_tags()
            favorites = user_tags.get("favorites", {})

            # Compatibility migration
            if isinstance(favorites, list):
                favorites = self.get_favorites()
            
            removed = False
            
            # If category is specified, only delete within that category
            if category:
                # Try direct category match (exact match)
                target_categories = [category]

                # If not found, try fuzzy match (handle filename suffix differences)
                if category not in favorites:
                    # e.g. category is "foo", favorites has "foo.csv" or vice versa
                    # But usually favorites keys already have suffix removed
                    pass

                for cat in target_categories:
                    if cat in favorites and isinstance(favorites[cat], dict):
                        # Delete by value
                        keys_to_remove = [k for k, v in favorites[cat].items() if v == tag_value]
                        for k in keys_to_remove:
                            del favorites[cat][k]
                            removed = True
                            
                        # If category is empty, should we delete the category key? Keep for now
            else:
                # No category specified, recursively delete all (legacy logic)
                # If it's old flat structure
                if any(not isinstance(v, dict) for v in favorites.values()):
                    keys_to_remove = [k for k, v in favorites.items() if not isinstance(v, dict) and v == tag_value]
                    for k in keys_to_remove:
                        del favorites[k]
                        removed = True
                
                # If it's new nested structure
                for cat, items in favorites.items():
                    if isinstance(items, dict):
                        keys_to_remove = [k for k, v in items.items() if v == tag_value]
                        for k in keys_to_remove:
                            del items[k]
                            removed = True
            
            if removed:
                user_tags["favorites"] = favorites
                return self.save_user_tags(user_tags)
                
            return True
        except Exception as e:
            self._log(f"Failed to remove favorite: {str(e)}")
            return False

    def get_system_prompts(self):
        """Get system prompts configuration (merge prompt definitions and active state)"""
        system_prompts = self.load_system_prompts()
        active_prompts = self.load_active_prompts()
        system_prompts['active_prompts'] = active_prompts
        return system_prompts

    def update_system_prompts(self, system_prompts):
        """Update system prompts configuration (only update prompt definitions)"""
        prompts_to_save = system_prompts.copy()
        if 'active_prompts' in prompts_to_save:
            del prompts_to_save['active_prompts']
        return self.save_system_prompts(prompts_to_save)

    def update_active_prompts(self, active_prompts):
        """Update all active prompts"""
        return self.save_active_prompts(active_prompts)

    def update_active_prompt(self, prompt_type, prompt_id):
        """Update a single active prompt"""
        active_prompts = self.load_active_prompts()
        active_prompts[prompt_type] = prompt_id
        return self.save_active_prompts(active_prompts)

    def get_baidu_translate_config(self):
        """Get Baidu Translate configuration"""
        config = self.load_config()
        return config.get("baidu_translate", self.default_config["baidu_translate"])

    def get_llm_config(self):
        """Get LLM configuration"""
        config = self.load_config()
        current_service_info = config.get('current_services', {}).get('llm')

        # Adapt to old and new formats: support string (old) and dict (new)
        if isinstance(current_service_info, str):
            # Old format: "service_id"
            current_service_id = current_service_info
            current_model_name = None
        elif isinstance(current_service_info, dict):
            # New format: {"service": "service_id", "model": "model_name"}
            current_service_id = current_service_info.get('service')
            current_model_name = current_service_info.get('model')
        else:
            # Not set
            current_service_id = None
            current_model_name = None

        if not current_service_id:
            # No service selected, return default structure
            return self._get_empty_llm_config()

        # Find the corresponding service
        service = self._get_service_by_id(current_service_id)
        if not service:
            return self._get_empty_llm_config()

        # Get LLM model list
        llm_models = service.get('llm_models', [])

        # If model name is specified, try to find it
        target_model = None
        if current_model_name:
            target_model = next((m for m in llm_models if m.get('name') == current_model_name), None)

        # If specified model not found, use default model or first model
        if not target_model:
            target_model = next((m for m in llm_models if m.get('is_default')), 
                                llm_models[0] if llm_models else None)
        
        if not target_model:
            return self._get_empty_llm_config()

        # Get API Key directly (stored in plaintext)
        api_key = service.get('api_key', '')

        # Return configuration
        return {
            "provider": service.get('id', ''),  # Use service_id as provider
            "model": target_model.get('name', ''),
            "base_url": service.get('base_url', ''),
            "api_key": api_key,
            "temperature": target_model.get('temperature', 0.7),
            "max_tokens": target_model.get('max_tokens', 1000),
            "top_p": target_model.get('top_p', 0.9),
            "auto_unload": service.get('auto_unload', True) if service.get('type') == 'ollama' else None,
            "providers": {}  # No longer used in v2.0
        }


    def _get_empty_llm_config(self):
        """Return empty LLM configuration"""
        return {
            "provider": "",
            "model": "",
            "base_url": "",
            "api_key": "",
            "temperature": 0.7,
            "max_tokens": 1000,
            "top_p": 0.9,
            "providers": {}
        }
    
    def _get_service_by_id(self, service_id: str) -> dict:
        """Get service configuration by ID"""
        config = self.load_config()
        services = config.get('model_services', [])
        for service in services:
            if service.get('id') == service_id:
                return service
        return None

    def get_vision_config(self):
        """Get vision model configuration"""
        config = self.load_config()
        current_service_info = config.get('current_services', {}).get('vlm')

        # Adapt to old and new formats: support string (old) and dict (new)
        if isinstance(current_service_info, str):
            # Old format: "service_id"
            current_service_id = current_service_info
            current_model_name = None
        elif isinstance(current_service_info, dict):
            # New format: {"service": "service_id", "model": "model_name"}
            current_service_id = current_service_info.get('service')
            current_model_name = current_service_info.get('model')
        else:
            # Not set
            current_service_id = None
            current_model_name = None

        if not current_service_id:
            # No service selected, return default structure
            return self._get_empty_vision_config()

        # Find the corresponding service
        service = self._get_service_by_id(current_service_id)
        if not service:
            return self._get_empty_vision_config()

        # Get VLM model list
        vlm_models = service.get('vlm_models', [])

        # If model name is specified, try to find it
        target_model = None
        if current_model_name:
            target_model = next((m for m in vlm_models if m.get('name') == current_model_name), None)

        # If specified model not found, use default model or first model
        if not target_model:
            target_model = next((m for m in vlm_models if m.get('is_default')), 
                                vlm_models[0] if vlm_models else None)
        
        if not target_model:
            return self._get_empty_vision_config()

        # Get API Key directly (stored in plaintext)
        api_key = service.get('api_key', '')

        # Return configuration
        return {
            "provider": service.get('id', ''),  # Use service_id as provider
            "model": target_model.get('name', ''),
            "base_url": service.get('base_url', ''),
            "api_key": api_key,
            "temperature": target_model.get('temperature', 0.7),
            "max_tokens": target_model.get('max_tokens', 1024),
            "top_p": target_model.get('top_p', 0.9),
            "auto_unload": service.get('auto_unload', True) if service.get('type') == 'ollama' else None,
            "providers": {}  # No longer used in v2.0
        }

    def _get_empty_vision_config(self):
        """Return empty vision model configuration"""
        return {
            "provider": "",
            "model": "",
            "base_url": "",
            "api_key": "",
            "temperature": 0.7,
            "max_tokens": 1024,
            "top_p": 0.9,
            "providers": {}
        }

    def get_translate_config(self):
        """Get translation service configuration (supports Baidu Translate and LLM translation)"""
        config = self.load_config()
        current_service_info = config.get('current_services', {}).get('translate')

        # Adapt to old and new formats: support string (old) and dict (new)
        if isinstance(current_service_info, str):
            # Old format: "service_id"
            current_service_id = current_service_info
            current_model_name = None
        elif isinstance(current_service_info, dict):
            # New format: {"service": "service_id", "model": "model_name"}
            current_service_id = current_service_info.get('service')
            current_model_name = current_service_info.get('model')
        else:
            # Not set, default to Baidu Translate
            current_service_id = 'baidu'
            current_model_name = None

        # Special handling for Baidu Translate (uses independent baidu_translate config)
        if current_service_id == 'baidu':
            baidu_config = self.get_baidu_translate_config()
            return {
                "provider": "baidu",
                "model": "",
                "base_url": "",
                "api_key": baidu_config.get('app_id', ''),
                "secret_key": baidu_config.get('secret_key', ''),
                "temperature": 0.7,
                "max_tokens": 1000,
                "top_p": 0.9,
                "providers": {}
            }
        
        # Find the corresponding LLM service
        service = self._get_service_by_id(current_service_id)
        if not service:
            # Service does not exist, fall back to Baidu Translate
            baidu_config = self.get_baidu_translate_config()
            return {
                "provider": "baidu",
                "model": "",
                "base_url": "",
                "api_key": baidu_config.get('app_id', ''),
                "secret_key": baidu_config.get('secret_key', ''),
                "temperature": 0.7,
                "max_tokens": 1000,
                "top_p": 0.9,
                "providers": {}
            }
        
        # Get LLM model list
        llm_models = service.get('llm_models', [])

        # If model name is specified, try to find it
        target_model = None
        if current_model_name:
            target_model = next((m for m in llm_models if m.get('name') == current_model_name), None)

        # If specified model not found, use default model or first model
        if not target_model:
            target_model = next((m for m in llm_models if m.get('is_default')),
                                llm_models[0] if llm_models else None)

        if not target_model:
            # No available model, fall back to Baidu Translate
            baidu_config = self.get_baidu_translate_config()
            return {
                "provider": "baidu",
                "model": "",
                "base_url": "",
                "api_key": baidu_config.get('app_id', ''),
                "secret_key": baidu_config.get('secret_key', ''),
                "temperature": 0.7,
                "max_tokens": 1000,
                "top_p": 0.9,
                "providers": {}
            }
        
        # Return LLM translation configuration
        api_key = service.get('api_key', '')
        return {
            "provider": service.get('id', ''),
            "model": target_model.get('name', ''),
            "base_url": service.get('base_url', ''),
            "api_key": api_key,
            "temperature": target_model.get('temperature', 0.7),
            "max_tokens": target_model.get('max_tokens', 1000),
            "top_p": target_model.get('top_p', 0.9),
            "auto_unload": service.get('auto_unload', True) if service.get('type') == 'ollama' else None,
            "providers": {}
        }

    def get_settings(self):
        """Get ComfyUI user settings (read from settings file)"""
        try:
            # ComfyUI settings file is usually located at user/default/comfy.settings.json
            # Need to find ComfyUI root directory
            import sys

            # Try to find settings file from multiple possible paths
            possible_paths = []

            # Method 1: Search upward from current file path
            current_dir = os.path.dirname(os.path.abspath(__file__))
            # custom_nodes/comfyui_prompt_assistant -> custom_nodes -> ComfyUI
            comfyui_root = os.path.dirname(os.path.dirname(current_dir))
            possible_paths.append(os.path.join(comfyui_root, "user", "default", "comfy.settings.json"))
            
            # Method 2: Search through sys.path
            for path in sys.path:
                if 'ComfyUI' in path:
                    possible_paths.append(os.path.join(path, "user", "default", "comfy.settings.json"))
            
            # Try to read settings file
            for settings_path in possible_paths:
                if os.path.exists(settings_path):
                    try:
                        with open(settings_path, 'r', encoding='utf-8') as f:
                            settings_data = json.load(f)
                            # Return settings data
                            return settings_data
                    except Exception as e:
                        self._log(f"Failed to read settings file: {settings_path}, error: {str(e)}")
                        continue
            
            # If none found, return empty dictionary
            return {}
            
        except Exception as e:
            # If unable to get settings, return empty dictionary
            self._log(f"Failed to get user settings: {str(e)}")
            return {}

    def update_baidu_translate_config(self, app_id=None, secret_key=None):
        """Update Baidu Translate configuration"""
        config = self.load_config()
        if "baidu_translate" not in config:
            config["baidu_translate"] = {}

        # Only update provided parameters
        if app_id is not None:
            config["baidu_translate"]["app_id"] = app_id
        if secret_key is not None:
            config["baidu_translate"]["secret_key"] = secret_key

        return self.save_config(config)




    # --- Note: validate_and_fix_system_prompts has been migrated to migration_tool.py ---
    # System prompt validation and completion is handled uniformly by migration_tool's incremental update logic


    def validate_and_fix_active_prompts(self):
        """
        Validate whether active prompts exist, fix if they don't

        Note: This method only fixes active_prompts.json (switches to an existing prompt)
        It will not restore deleted content in system_prompts.json (respects user's delete operations)
        """
        try:
            system_prompts = self.load_system_prompts()
            active_prompts = self.load_active_prompts()

            # Flag whether active prompts need updating
            modified = False

            # Check and fix expand prompts
            if "expand" in active_prompts:
                expand_id = active_prompts["expand"]
                expand_prompts = system_prompts.get("expand_prompts", {})
                
                if expand_id not in expand_prompts:
                    # Active prompt does not exist, switch to the first available
                    if expand_prompts:
                        first_expand_id = next(iter(expand_prompts))
                        active_prompts["expand"] = first_expand_id
                        self._log(f"Active expand prompt '{expand_id}' does not exist, switched to '{first_expand_id}'")
                        modified = True
                    else:
                        # No available expand prompts, clear active selection
                        active_prompts["expand"] = ""
                        self._log(f"Warning: No available expand prompts")
                        modified = True

            # Check and fix Chinese vision prompts
            if "vision_zh" in active_prompts:
                vision_zh_id = active_prompts["vision_zh"]
                vision_prompts = system_prompts.get("vision_prompts", {})
                zh_prompts = {k: v for k, v in vision_prompts.items() if k.startswith("vision_zh_")}
                
                if vision_zh_id not in vision_prompts:
                    if zh_prompts:
                        first_id = next(iter(zh_prompts))
                        active_prompts["vision_zh"] = first_id
                        self._log(f"激活的中文反推提示词 '{vision_zh_id}' 不存在，已切换到 '{first_id}'")
                        modified = True
                    else:
                        active_prompts["vision_zh"] = ""
                        self._log(f"警告：没有可用的中文反推提示词")
                        modified = True

            # 检查并修复英文反推提示词
            if "vision_en" in active_prompts:
                vision_en_id = active_prompts["vision_en"]
                vision_prompts = system_prompts.get("vision_prompts", {})
                en_prompts = {k: v for k, v in vision_prompts.items() if k.startswith("vision_en_")}
                
                if vision_en_id not in vision_prompts:
                    if en_prompts:
                        first_id = next(iter(en_prompts))
                        active_prompts["vision_en"] = first_id
                        self._log(f"激活的英文反推提示词 '{vision_en_id}' 不存在，已切换到 '{first_id}'")
                        modified = True
                    else:
                        active_prompts["vision_en"] = ""
                        self._log(f"警告：没有可用的英文反推提示词")
                        modified = True

            # 如果需要更新，保存修复后的激活提示词
            if modified:
                self.save_active_prompts(active_prompts)
                self._log("已完成激活提示词的验证和修复")

        except Exception as e:
            self._log(f"验证激活提示词异常: {str(e)}")



    def validate_and_fix_model_params(self):
        """
        验证并修复模型参数配置
        注意: v2.0版本中，模型参数直接存储在 model_services 数组的模型对象中，
        这个方法主要用于确保配置文件存在和格式正确
        """
        try:
            config = self.load_config()
            
            # 确保是 v2.0 格式
            if not self._is_v2_config(config):
                self._log("[config.json] 警告: 检测到旧版本配置，请手动创建新的配置文件或使用默认配置")
                return
            
            # v2.0 格式中，参数已经在各个服务的模型列表中，无需额外验证
            # 如果需要补全缺失的服务或模型参数，应该在服务商管理API中处理
            
        except Exception as e:
            self._log(f"[config.json] 验证模型参数配置时出错: {str(e)}")


    # --- API Key 安全相关方法（方案A）---
    
    @staticmethod
    def mask_api_key(api_key: str) -> str:
        """
        掩码API Key，只显示首尾部分
        用于前端安全显示，防止API Key在Network中明文可见
        
        参数:
            api_key: 明文API Key
            
        返回:
            str: 掩码后的API Key
            
        示例:
            - sk-abc123xyz789 -> sk-abc***xyz789
            - 短Key (< 8字符) -> ***
            - 空字符串 -> ""
        """
        if not api_key:
            return ""
        if len(api_key) < 8:
            return "***"
        # 显示前6个字符和后4个字符
        return f"{api_key[:6]}***{api_key[-4:]}"
    
    def get_llm_config_masked(self):
        """
        获取LLM配置（API Key掩码版本）
        用于前端显示，不暴露完整API Key
        
        返回:
            Dict: LLM配置，api_key字段被掩码
        """
        config = self.get_llm_config()
        
        if 'api_key' in config:
            # 掩码API Key
            config['api_key_masked'] = self.mask_api_key(config['api_key'])
            config['api_key_exists'] = bool(config['api_key'])
            # 移除明文API Key
            del config['api_key']
        
        # 处理所有providers的API Key
        if 'providers' in config:
            for provider_name, provider_config in config['providers'].items():
                if 'api_key' in provider_config:
                    provider_config['api_key_masked'] = self.mask_api_key(provider_config['api_key'])
                    provider_config['api_key_exists'] = bool(provider_config['api_key'])
                    del provider_config['api_key']
        
        return config
    
    def get_vision_config_masked(self):
        """
        获取视觉模型配置（API Key掩码版本）
        用于前端显示，不暴露完整API Key
        
        返回:
            Dict: 视觉模型配置，api_key字段被掩码
        """
        config = self.get_vision_config()
        
        if 'api_key' in config:
            # 掩码API Key
            config['api_key_masked'] = self.mask_api_key(config['api_key'])
            config['api_key_exists'] = bool(config['api_key'])
            # 移除明文API Key
            del config['api_key']
        
        # 处理所有providers的API Key
        if 'providers' in config:
            for provider_name, provider_config in config['providers'].items():
                if 'api_key' in provider_config:
                    provider_config['api_key_masked'] = self.mask_api_key(provider_config['api_key'])
                    provider_config['api_key_exists'] = bool(provider_config['api_key'])
                    del provider_config['api_key']
        
        return config
    
    # --- 服务商管理方法（CRUD）---
    
    def get_all_services(self):
        """
        获取所有服务商列表
        
        返回:
            List[Dict]: 服务商列表
        """
        config = self.load_config()
        
        if self._is_v2_config(config):
            return config.get('model_services', [])
        else:
            # v1.0不支持此功能
            return []
    
    def get_service(self, service_id: str):
        """
        获取指定服务商的完整配置
        
        参数:
            service_id: 服务商ID
            
        返回:
            Dict: 服务商配置，不存在返回None
        """
        return self._get_service_by_id(service_id)
    
    def create_service(self, service_type: str, name: str = "", base_url: str = "", 
                      api_key: str = "", description: str = ""):
        """
        创建新的服务商
        
        参数:
            service_type: 服务类型 ('openai_compatible' 或 'ollama')
            name: 服务商名称（如果为空，自动生成）
            base_url: Base URL
            api_key: API Key（明文存储）
            description: 描述
            
        返回:
            str: 新创建的service_id，失败返回None
        """
        try:
            config = self.load_config()
            
            if not self._is_v2_config(config):
                self._log("创建服务商失败: 配置版本过低，请先迁移到v2.0")
                return None
            
            # 获取现有服务商列表
            current_services = config.get('model_services', [])
            
            # 生成服务商ID和名称
            service_id, auto_name = self._generate_service_id_and_name(service_type, current_services)
            
            # 如果用户没有提供名称，使用自动生成的名称
            if not name:
                name = auto_name
            
            # 创建服务配置
            new_service = {
                "id": service_id,
                "type": service_type,
                "name": name,
                "description": description,
                "base_url": base_url,
                "api_key": api_key or "",
                "disable_thinking": True,
                "enable_advanced_params": True,
                "filter_thinking_output": True,
                "llm_models": [],
                "vlm_models": []
            }
            
            # Ollama特有配置
            if service_type == "ollama":
                new_service["auto_unload"] = True
            
            # 添加到配置
            if 'model_services' not in config:
                config['model_services'] = []
            
            config['model_services'].append(new_service)
            
            # 保存配置
            if self.save_config(config):
                self._log(f"成功创建服务商: {name} (ID: {service_id})")
                return service_id
            else:
                self._log(f"保存服务商配置失败: {name}")
                return None
                
        except Exception as e:
            self._log(f"创建服务商异常: {str(e)}")
            import traceback
            traceback.print_exc()
            return None
    
    def _generate_service_id_and_name(self, service_type: str, current_services: list) -> tuple:
        """
        生成服务商ID和默认名称
        
        参数:
            service_type: 服务类型
            current_services: 现有服务商列表
            
        返回:
            tuple: (service_id, default_name)
        """
        import random
        
        # 类型映射
        type_map = {
            "ollama": {
                "name_prefix": "Ollama服务",
                "id_prefix": "ollama"
            },
            "openai_compatible": {
                "name_prefix": "通用服务",
                "id_prefix": "service"
            }
        }
        
        # 获取类型配置
        type_config = type_map.get(service_type, {
            "name_prefix": "新服务",
            "id_prefix": service_type
        })
        
        name_prefix = type_config["name_prefix"]
        id_prefix = type_config["id_prefix"]
        
        # 收集已使用的编号
        existing_numbers = set()
        for service in current_services:
            sid = service.get('id', '')
            # 匹配格式：{id_prefix}_{数字}
            if sid.startswith(f"{id_prefix}_"):
                try:
                    num_str = sid.split('_')[-1]
                    if num_str.isdigit():
                        existing_numbers.add(int(num_str))
                except:
                    pass
        
        # 生成随机三位数（100-999），最多尝试100次
        max_attempts = 100
        for _ in range(max_attempts):
            random_number = random.randint(100, 999)
            if random_number not in existing_numbers:
                break
        else:
            # 如果100次都重复，使用更大的随机数（4位数）
            random_number = random.randint(1000, 9999)
            while random_number in existing_numbers:
                random_number = random.randint(1000, 9999)
        
        # 生成ID和名称
        service_id = f"{id_prefix}_{random_number}"
        default_name = f"{name_prefix}-{random_number}"
        
        return service_id, default_name
    
    def delete_service(self, service_id: str):
        """
        删除服务商
        
        参数:
            service_id: 服务商ID
            
        返回:
            bool: 成功返回True
        """
        try:
            config = self.load_config()
            
            if not self._is_v2_config(config):
                self._log("删除服务商失败: 配置版本过低")
                return False
            
            services = config.get('model_services', [])
            
            # 查找并删除服务
            original_length = len(services)
            config['model_services'] = [s for s in services if s.get('id') != service_id]
            
            if len(config['model_services']) == original_length:
                self._log(f"删除服务商失败: 服务商不存在 (ID: {service_id})")
                return False
            
            # 如果删除的是当前服务，清除current_services引用
            current_services = config.get('current_services', {})
            if current_services.get('llm') == service_id:
                current_services['llm'] = None
            if current_services.get('vlm') == service_id:
                current_services['vlm'] = None
            if current_services.get('translate') == service_id:
                current_services['translate'] = None
            
            # 保存配置
            if self.save_config(config):
                self._log(f"成功删除服务商: {service_id}")
                return True
            else:
                self._log(f"保存配置失败")
                return False
                
        except Exception as e:
            self._log(f"删除服务商异常: {str(e)}")
            import traceback
            traceback.print_exc()
            return False

    def update_services_order(self, service_ids: list) -> bool:
        """
        更新服务商顺序

        参数:
            service_ids: 服务商ID列表,按新顺序排列

        返回:
            bool: 成功返回True
        """
        try:
            config = self.load_config()

            if not self._is_v2_config(config):
                self._log("更新服务商顺序失败: 配置版本过低")
                return False

            services = config.get('model_services', [])

            # 创建ID到服务的映射
            service_map = {s.get('id'): s for s in services}

            # 验证所有service_id都存在
            for service_id in service_ids:
                if service_id not in service_map:
                    self._log(f"更新服务商顺序失败: 服务商不存在 (ID: {service_id})")
                    return False

            # 按新顺序重建services数组
            new_services = []
            for service_id in service_ids:
                new_services.append(service_map[service_id])

            # 添加未在service_ids中的服务(防止遗漏)
            for service_id, service in service_map.items():
                if service_id not in service_ids:
                    new_services.append(service)
                    self._log(f"警告: 服务商 {service_id} 不在新顺序中,已追加到末尾")

            config['model_services'] = new_services

            # 保存配置
            if self.save_config(config):
                self._log(f"成功更新服务商顺序: {', '.join(service_ids)}")
                return True
            else:
                self._log("保存配置失败")
                return False

        except Exception as e:
            self._log(f"更新服务商顺序异常: {str(e)}")
            import traceback
            traceback.print_exc()
            return False

    
    def update_service(self, service_id: str, **kwargs):
        """
        更新服务商配置
        
        参数:
            service_id: 服务商ID
            **kwargs: 要更新的字段（name, description, base_url, api_key, auto_unload等）
            
        返回:
            bool: 成功返回True
        """
        try:
            config = self.load_config()
            
            if not self._is_v2_config(config):
                self._log("更新服务商失败: 配置版本过低")
                return False
            
            # 查找服务
            services = config.get('model_services', [])
            service = None
            service_index = -1
            
            for i, s in enumerate(services):
                if s.get('id') == service_id:
                    service = s
                    service_index = i
                    break
            
            if not service:
                self._log(f"更新服务商失败: 服务商不存在 (ID: {service_id})")
                return False
            
            # 更新字段
            if 'name' in kwargs:
                service['name'] = kwargs['name']
            
            if 'description' in kwargs:
                service['description'] = kwargs['description']
            
            if 'base_url' in kwargs:
                service['base_url'] = kwargs['base_url']
            
            if 'api_key' in kwargs:
                # 直接使用明文API Key
                service['api_key'] = kwargs['api_key'] or ""
            
            if 'auto_unload' in kwargs and service.get('type') == 'ollama':
                service['auto_unload'] = kwargs['auto_unload']
            
            if 'disable_thinking' in kwargs:
                service['disable_thinking'] = kwargs['disable_thinking']
            
            if 'enable_advanced_params' in kwargs:
                service['enable_advanced_params'] = kwargs['enable_advanced_params']
            
            if 'filter_thinking_output' in kwargs:
                service['filter_thinking_output'] = kwargs['filter_thinking_output']
            
            # 更新services数组
            config['model_services'][service_index] = service
            
            # 保存配置
            if self.save_config(config):
                self._log(f"成功更新服务商: {service_id}")
                return True
            else:
                self._log(f"保存配置失败")
                return False
                
        except Exception as e:
            self._log(f"更新服务商异常: {str(e)}")
            import traceback
            traceback.print_exc()
            return False
    
    def set_current_service(self, service_type: str, service_id: str, model_name: str = None):
        """
        设置当前使用的服务商和模型
        
        参数:
            service_type: 服务类型 ('llm', 'vlm', 或 'translate')
            service_id: 服务商ID
            model_name: 模型名称(可选,如果不提供则使用该服务的默认模型或第一个模型)
            
        返回:
            bool: 成功返回True
        """
        try:
            config = self.load_config()
            
            if not self._is_v2_config(config):
                self._log("设置当前服务商失败: 配置版本过低")
                return False
            
            # ---百度翻译特殊处理---
            # 百度翻译使用独立的baidu_translate配置,不在model_services中
            if service_id == 'baidu':
                # 百度翻译支持LLM服务类型(旧兼容)和translate服务类型
                if service_type not in ['llm', 'translate']:
                    self._log(f"设置当前服务商失败: 百度翻译不支持{service_type}服务类型")
                    return False
                
                # 确保baidu_translate配置存在
                if 'baidu_translate' not in config:
                    config['baidu_translate'] = {"app_id": "", "secret_key": ""}
                
                # 确保current_services结构存在
                if 'current_services' not in config:
                    config['current_services'] = {}
                
                # 设置百度为当前服务(无模型概念)
                config['current_services'][service_type] = {
                    "service": "baidu",
                    "model": ""
                }
                
                # 保存配置
                if self.save_config(config):
                    self._log(f"当前服务商已切换: 百度翻译 ({service_type})")
                    return True
                else:
                    self._log("设置当前服务商失败: 保存配置失败")
                    return False
            
            # ---其他服务:验证服务存在---
            service = self._get_service_by_id(service_id)
            if not service:
                self._log(f"设置当前服务商失败: 服务商不存在 (ID: {service_id})")
                return False
            
            # 根据service_type确定模型列表字段
            model_list_key = f'{service_type}_models'
            if service_type == 'translate':
                model_list_key = 'llm_models'
            
            # 如果提供了model_name,验证模型是否存在
            if model_name:
                model_list = service.get(model_list_key, [])
                model_exists = any(m.get('name') == model_name for m in model_list)
                
                if not model_exists:
                    self._log(f"设置当前服务商失败: 模型不存在 (模型: {model_name}, 服务: {service_id})")
                    return False
           
            # 确保current_services结构存在
            if 'current_services' not in config:
                config['current_services'] = {}
            
            # 获取当前服务信息(兼容旧格式)
            current_info = config['current_services'].get(service_type)
            
            # 设置新格式的current_services
            if model_name:
                # 明确指定了模型
                config['current_services'][service_type] = {
                    "service": service_id,
                    "model": model_name
                }
            else:
                # 未指定模型,使用默认模型或第一个模型
                model_list = service.get(model_list_key, [])
                
                # 如果是百度服务,没有模型
                if service.get('id') == 'baidu' or service.get('type') == 'baidu':
                    config['current_services'][service_type] = {
                        "service": service_id,
                        "model": ""
                    }
                else:
                    # 查找默认模型或第一个模型
                    default_model = next((m for m in model_list if m.get('is_default')), 
                                        model_list[0] if model_list else None)
                    
                    if default_model:
                        config['current_services'][service_type] = {
                            "service": service_id,
                            "model": default_model.get('name', '')
                        }
                    else:
                        # 没有模型,只设置服务
                        config['current_services'][service_type] = {
                            "service": service_id,
                            "model": ""
                        }
            
            # 保存配置
            if self.save_config(config):
                service_name = service.get('name', service_id)
                log_model = f" | 模型:{model_name}" if model_name else ""
                self._log(f"成功设置当前{service_type}服务: {service_name}{log_model}")
                return True
            else:
                self._log(f"保存配置失败")
                return False
                
        except Exception as e:
            import traceback
            traceback.print_exc()
            return False
    
    # --- 模型管理方法 ---
    
    def add_model_to_service(self, service_id: str, model_type: str, model_name: str, 
                            temperature: float = 0.7, top_p: float = 0.9, max_tokens: int = 1024):
        """添加模型到服务商"""
        try:
            config = self.load_config()
            services = config.get('model_services', [])
            
            for i, service in enumerate(services):
                if service.get('id') == service_id:
                    model_list_key = 'llm_models' if model_type == 'llm' else 'vlm_models'
                    
                    if model_list_key not in service:
                        service[model_list_key] = []
                    
                    # 检查是否已存在
                    if any(m.get('name') == model_name for m in service[model_list_key]):
                        self._log(f"模型已存在: {model_name}")
                        return False
                    
                    # 添加新模型
                    new_model = {
                        "name": model_name,
                        "is_default": len(service[model_list_key]) == 0,
                        "temperature": temperature,
                        "top_p": top_p,
                        "max_tokens": max_tokens
                    }
                    service[model_list_key].append(new_model)
                    config['model_services'][i] = service
                    
                    if self.save_config(config):
                        self._log(f"成功添加模型: {model_name}")
                        return True
                    return False
            
            self._log(f"服务商不存在: {service_id}")
            return False
        except Exception as e:
            self._log(f"添加模型异常: {str(e)}")
            return False
    
    def delete_model_from_service(self, service_id: str, model_type: str, model_name: str):
        """从服务商删除模型"""
        try:
            config = self.load_config()
            services = config.get('model_services', [])
            
            for i, service in enumerate(services):
                if service.get('id') == service_id:
                    model_list_key = 'llm_models' if model_type == 'llm' else 'vlm_models'
                    
                    if model_list_key not in service:
                        return False
                    
                    original_length = len(service[model_list_key])
                    service[model_list_key] = [m for m in service[model_list_key] if m.get('name') != model_name]
                    
                    if len(service[model_list_key]) == original_length:
                        self._log(f"模型不存在: {model_name}")
                        return False
                    
                    # 如果删除的是默认模型，设置第一个为默认
                    if len(service[model_list_key]) > 0:
                        if not any(m.get('is_default') for m in service[model_list_key]):
                            service[model_list_key][0]['is_default'] = True
                    
                    config['model_services'][i] = service
                    
                    if self.save_config(config):
                        self._log(f"成功删除模型: {model_name}")
                        return True
                    return False
            
            self._log(f"服务商不存在: {service_id}")
            return False
        except Exception as e:
            self._log(f"删除模型异常: {str(e)}")
            return False
    
    def set_default_model(self, service_id: str, model_type: str, model_name: str):
        """设置默认模型"""
        try:
            config = self.load_config()
            services = config.get('model_services', [])
            
            for i, service in enumerate(services):
                if service.get('id') == service_id:
                    model_list_key = 'llm_models' if model_type == 'llm' else 'vlm_models'
                    
                    if model_list_key not in service:
                        return False
                    
                    found = False
                    for model in service[model_list_key]:
                        if model.get('name') == model_name:
                            model['is_default'] = True
                            found = True
                        else:
                            model['is_default'] = False
                    
                    if not found:
                        self._log(f"模型不存在: {model_name}")
                        return False
                    
                    config['model_services'][i] = service
                    
                    if self.save_config(config):
                        self._log(f"成功设置默认模型: {model_name}")
                        return True
                    return False
            
            self._log(f"服务商不存在: {service_id}")
            return False
        except Exception as e:
            self._log(f"设置默认模型异常: {str(e)}")
            return False
    
    def update_model_order(self, service_id: str, model_type: str, model_names: list):
        """更新模型顺序"""
        try:
            config = self.load_config()
            services = config.get('model_services', [])
            
            for i, service in enumerate(services):
                if service.get('id') == service_id:
                    model_list_key = 'llm_models' if model_type == 'llm' else 'vlm_models'
                    
                    if model_list_key not in service:
                        return False
                    
                    # 创建模型字典
                    model_dict = {m.get('name'): m for m in service[model_list_key]}
                    
                    # 按新顺序重新排列
                    new_model_list = []
                    for name in model_names:
                        if name in model_dict:
                            new_model_list.append(model_dict[name])
                    
                    service[model_list_key] = new_model_list
                    config['model_services'][i] = service
                    
                    if self.save_config(config):
                        self._log(f"成功更新模型顺序")
                        return True
                    return False
            
            self._log(f"服务商不存在: {service_id}")
            return False
        except Exception as e:
            self._log(f"更新模型顺序异常: {str(e)}")
            return False
    
    def update_model_parameter(self, service_id: str, model_type: str, model_name: str, 
                               parameter_name: str, parameter_value):
        """更新模型参数"""
        try:
            config = self.load_config()
            services = config.get('model_services', [])
            
            for i, service in enumerate(services):
                if service.get('id') == service_id:
                    model_list_key = 'llm_models' if model_type == 'llm' else 'vlm_models'
                    
                    if model_list_key not in service:
                        return False
                    
                    # 查找模型并更新参数
                    for model in service[model_list_key]:
                        if model.get('name') == model_name:
                            model[parameter_name] = parameter_value
                            config['model_services'][i] = service
                            
                            if self.save_config(config):
                                self._log(f"成功更新模型参数: {model_name}.{parameter_name} = {parameter_value}")
                                return True
                            return False
                    
                    self._log(f"模型不存在: {model_name}")
                    return False
            
            self._log(f"服务商不存在: {service_id}")
            return False
        except Exception as e:
            self._log(f"更新模型参数异常: {str(e)}")
            return False

# 创建全局配置管理器实例
config_manager = ConfigManager()