"""
Data Migration Tool

Handles migration from old version config files to new versions
Called on demand, does not affect normal runtime performance
"""

import os
import json
import csv


class MigrationTool:
    """Data migration tool class"""

    def __init__(self, plugin_dir, user_base_dir, logger=None):
        """
        Initialize the migration tool

        Args:
            plugin_dir: Plugin directory path
            user_base_dir: User config base directory
            logger: Log function (optional)
        """
        self.plugin_dir = plugin_dir
        self.user_base_dir = user_base_dir
        if logger:
            self._log_func = logger
        else:
            def default_logger(msg):
                from .common import _ANSI_CLEAR_EOL
                print(f"\r{_ANSI_CLEAR_EOL}{msg}", flush=True)
            self._log_func = default_logger
            
        # Define paths
        self.legacy_config_dir = os.path.join(plugin_dir, "config")
        self.config_dir = os.path.join(user_base_dir, "config")
        self.tags_dir = os.path.join(user_base_dir, "tags")
        self.rules_dir = os.path.join(user_base_dir, "rules")
            
    def _log(self, msg: str):
        """Unified log call layer"""
        self._log_func(msg)

    # ---Version Comparison Tool---
    def _compare_versions(self, v1: str, v2: str) -> int:
        """
        Compare two version numbers

        Returns:
            1: v1 > v2
            0: v1 == v2
            -1: v1 < v2
        """
        def parse(v):
            return [int(x) for x in str(v).split('.')]
        p1, p2 = parse(v1), parse(v2)
        # Pad to equal length
        max_len = max(len(p1), len(p2))
        p1.extend([0] * (max_len - len(p1)))
        p2.extend([0] * (max_len - len(p2)))
        for a, b in zip(p1, p2):
            if a > b: return 1
            if a < b: return -1
        return 0

    # ---config.json Dedicated Migration---
    def ensure_config_json_exists(self, file_path: str, default_data: dict, legacy_path: str = None) -> bool:
        """
        Ensure config.json exists (dedicated migration logic)

        Logic:
        1. File exists -> skip
        2. File doesn't exist + old file exists -> extract API Key and model info, map to new service providers
        3. File doesn't exist + no old file -> create default config
        """
        if os.path.exists(file_path):
            return False
        
        os.makedirs(os.path.dirname(file_path), exist_ok=True)
        
        # Check for legacy file
        if legacy_path and os.path.exists(legacy_path):
            try:
                with open(legacy_path, 'r', encoding='utf-8') as f:
                    legacy_data = json.load(f)

                # Execute dedicated migration: extract API Key and model info
                migrated_data = self._migrate_config_api_keys_to_services(legacy_data, default_data)
                self._save_with_version(file_path, migrated_data, default_data)
                self._log("[config.json] Migration from plugin directory complete (API Key and model info extracted)")
                return True
            except Exception as e:
                self._log(f"[config.json] Legacy file migration failed: {str(e)}, using default config")

        # Create default config
        self._log("[config.json] File does not exist, creating default config...")
        self._save_with_version(file_path, default_data, default_data)
        return True

    def _migrate_config_api_keys_to_services(self, legacy_data: dict, default_data: dict) -> dict:
        """
        Extract API Key and model info from legacy config, map to new config service providers

        Logic:
        1. Iterate through services with API Keys in legacy config
        2. Find corresponding service provider ID in new config
        3. If found, fill in API Key and model info
        4. If not found, create new service provider
        """
        import copy
        result = copy.deepcopy(default_data)
        
        # Extract service info from legacy config
        legacy_services = legacy_data.get('model_services', [])
        if not legacy_services:
            # Compatible with older format (llm/vlm providers)
            legacy_services = self._extract_legacy_providers(legacy_data)
        
        # Build ID mapping for new config service providers
        new_services = result.get('model_services', [])
        service_id_map = {s.get('id'): i for i, s in enumerate(new_services)}
        
        for legacy_service in legacy_services:
            api_key = legacy_service.get('api_key', '').strip()
            if not api_key:
                continue
            
            service_id = legacy_service.get('id', '')
            
            if service_id in service_id_map:
                # Service provider exists, update API Key and model info
                idx = service_id_map[service_id]
                new_services[idx]['api_key'] = api_key
                
                # Migrate model info
                for model_type in ['llm_models', 'vlm_models']:
                    legacy_models = legacy_service.get(model_type, [])
                    if legacy_models:
                        new_services[idx][model_type] = legacy_models
                
                # Migrate other config
                for key in ['base_url', 'auto_unload', 'disable_thinking', 'enable_advanced_params', 'filter_thinking_output']:
                    if key in legacy_service:
                        new_services[idx][key] = legacy_service[key]
                
                self._log(f"[config.json] Migrated service provider: {service_id}")
            else:
                # Service provider doesn't exist, create new one
                new_service = {
                    'id': service_id,
                    'type': legacy_service.get('type', 'openai_compatible'),
                    'name': legacy_service.get('name', service_id),
                    'description': legacy_service.get('description', f'{service_id} (migrated from legacy)'),
                    'base_url': legacy_service.get('base_url', ''),
                    'api_key': api_key,
                    'disable_thinking': legacy_service.get('disable_thinking', True),
                    'enable_advanced_params': legacy_service.get('enable_advanced_params', True),
                    'filter_thinking_output': legacy_service.get('filter_thinking_output', True),
                    'llm_models': legacy_service.get('llm_models', []),
                    'vlm_models': legacy_service.get('vlm_models', [])
                }
                new_services.append(new_service)
                self._log(f"[config.json] Created new service provider: {service_id}")
        
        # Migrate current_services
        if 'current_services' in legacy_data:
            result['current_services'] = legacy_data['current_services']
        
        # Migrate Baidu Translate config
        if 'baidu_translate' in legacy_data:
            result['baidu_translate'] = legacy_data['baidu_translate']
        
        result['model_services'] = new_services
        return result

    def _extract_legacy_providers(self, legacy_data: dict) -> list:
        """
        Extract service info from older config format (llm/vlm providers)

        Compatible with v1.0 format:
        {
            "llm": {"providers": {"zhipu": {...}, "custom": {...}}},
            "vlm": {"providers": {"zhipu": {...}}}
        }
        """
        services = []
        provider_map = {}  # Used to merge llm and vlm config of the same provider
        
        for service_type in ['llm', 'vlm']:
            if service_type not in legacy_data:
                continue
            providers = legacy_data[service_type].get('providers', {})
            
            for provider_name, provider_config in providers.items():
                api_key = provider_config.get('api_key', '').strip()
                if not api_key:
                    continue
                
                if provider_name not in provider_map:
                    provider_map[provider_name] = {
                        'id': provider_name,
                        'type': 'openai_compatible',
                        'name': provider_config.get('name', provider_name),
                        'base_url': provider_config.get('base_url', ''),
                        'api_key': api_key,
                        'llm_models': [],
                        'vlm_models': []
                    }
                
                # Add model info
                model_name = provider_config.get('model', '')
                if model_name:
                    models_key = f'{service_type}_models'
                    provider_map[provider_name][models_key].append({
                        'name': model_name,
                        'display_name': '',
                        'is_default': True,
                        'temperature': provider_config.get('temperature', 0.7),
                        'max_tokens': provider_config.get('max_tokens', 1000),
                        'top_p': provider_config.get('top_p', 0.9)
                    })
        
        services = list(provider_map.values())
        return services


    # ---Unified Save Method---
    def _save_with_version(self, file_path: str, data: dict, default_data: dict) -> bool:
        """
        Save config file, automatically handling version number

        Args:
            file_path: Target file path
            data: Data to save
            default_data: Default config (for obtaining version number)

        Returns:
            bool: True if save succeeded
        """
        try:
            # Ensure version number exists and is at the beginning
            version = data.get('__config_version') or default_data.get('__config_version', '2.0')
            data = {'__config_version': version, **{k: v for k, v in data.items() if k != '__config_version'}}
            
            with open(file_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            return True
        except Exception as e:
            self._log(f"Failed to save file [{os.path.basename(file_path)}]: {str(e)}")
            return False

    def _ensure_simple_config(self, file_path: str, default_data: dict, file_desc: str = "config") -> bool:
        """
        Simply ensure a config file exists (no version management or migration)

        Logic:
        - File exists -> skip
        - File doesn't exist -> create default config (without version number)

        Applicable to: active_prompts.json, tags_user.json and other simple config files
        """
        if os.path.exists(file_path):
            return False
        
        os.makedirs(os.path.dirname(file_path), exist_ok=True)
        
        try:
            # Remove version number (these files don't need version management)
            data_to_save = {k: v for k, v in default_data.items() if not k.startswith('__')}
            
            with open(file_path, 'w', encoding='utf-8') as f:
                json.dump(data_to_save, f, ensure_ascii=False, indent=2)
            self._log(f"[{file_desc}] File does not exist, creating default config...")
            return True
        except Exception as e:
            self._log(f"[{file_desc}] Failed to create default config: {str(e)}")
            return False

    # ---Ensure Config File Exists---
    def ensure_config_exists(self, file_path: str, default_data: dict, legacy_path: str = None, file_desc: str = "config") -> bool:
        """
        Ensure a single config file exists

        Logic:
        1. File exists -> skip (incremental updates handled by migrate_incremental_updates)
        2. File doesn't exist + old file exists -> migrate old file, merge with default config, add version number
        3. File doesn't exist + no old file -> create default config

        Args:
            file_path: Target file path
            default_data: Default config data
            legacy_path: Legacy file path (optional)
            file_desc: File description (for logging)

        Returns:
            bool: True if a new file was created, False if file already exists
        """
        if os.path.exists(file_path):
            return False
        
        # Ensure directory exists
        os.makedirs(os.path.dirname(file_path), exist_ok=True)

        # Check for legacy file
        if legacy_path and os.path.exists(legacy_path):
            try:
                with open(legacy_path, 'r', encoding='utf-8') as f:
                    legacy_data = json.load(f)

                # Merge with default config, fill in missing fields
                merged_data = self._merge_with_defaults(legacy_data, default_data, file_desc)
                self._save_with_version(file_path, merged_data, default_data)
                self._log(f"[{file_desc}] Migration from plugin directory complete")
                return True
            except Exception as e:
                self._log(f"[{file_desc}] Legacy file migration failed: {str(e)}, using default config")

        # Create default config
        self._log(f"[{file_desc}] File does not exist, creating default config...")
        self._save_with_version(file_path, default_data, default_data)
        return True

    def _merge_with_defaults(self, user_data: dict, default_data: dict, file_desc: str = "") -> dict:
        """
        Merge user data with default config, filling in missing fields

        Args:
            user_data: User data (legacy version)
            default_data: Default config
            file_desc: File description (for logging)

        Returns:
            Merged data
        """
        import copy
        result = copy.deepcopy(default_data)
        
        # Recursively merge user data into result (user data takes priority)
        self._recursive_merge(result, user_data, file_desc)
        
        return result

    def _recursive_merge(self, base: dict, overlay: dict, file_desc: str = "", path: str = ""):
        """
        Recursive merge: overlay values override base values (preserving base structure)

        Strategy:
        - Keys in overlay override values in base
        - If both are dict, merge recursively
        - Skip version fields (handled by _save_with_version)
        """
        for key, value in overlay.items():
            # Skip version fields
            if key.startswith("__"):
                continue
                
            current_path = f"{path}.{key}" if path else key
            
            if key in base:
                if isinstance(base[key], dict) and isinstance(value, dict):
                    # Recursively merge nested dictionaries
                    self._recursive_merge(base[key], value, file_desc, current_path)
                else:
                    # Direct override (user value takes priority)
                    base[key] = value
            else:
                # Keys in overlay but not in base, add directly (user custom content)
                base[key] = value

    def ensure_all_configs_exist(self, default_configs: dict, legacy_dir: str):
        """
        Ensure all config files exist

        Args:
            default_configs: Default config dictionary
            legacy_dir: Legacy file directory
        """
        # config.json (use dedicated migration method)
        if 'config' in default_configs:
            self.ensure_config_json_exists(
                os.path.join(self.config_dir, "config.json"),
                default_configs['config'],
                os.path.join(legacy_dir, "config.json")
            )
        
        # system_prompts.json
        if 'system_prompts' in default_configs:
            self.ensure_config_exists(
                os.path.join(self.rules_dir, "system_prompts.json"),
                default_configs['system_prompts'],
                os.path.join(legacy_dir, "system_prompts.json"),
                "system_prompts.json"
            )
        
        # active_prompts.json and tags_user.json don't need version management or migration,
        # just create default config when file doesn't exist
        self._ensure_simple_config(
            os.path.join(self.config_dir, "active_prompts.json"),
            default_configs.get('active_prompts', {}),
            "active_prompts.json"
        )
        
        self._ensure_simple_config(
            os.path.join(self.config_dir, "tags_user.json"),
            default_configs.get('tags_user', {"favorites": []}),
            "tags_user.json"
        )
        
        # kontext_presets.json
        if 'kontext_presets' in default_configs:
            self.ensure_config_exists(
                os.path.join(self.rules_dir, "kontext_presets.json"),
                default_configs['kontext_presets'],
                os.path.join(legacy_dir, "kontext_presets.json"),
                "kontext_presets.json"
            )

    def migrate_incremental_updates(self, default_configs):
        """
        Execute incremental updates: add new fields from default config to user config

        Args:
            default_configs: Dictionary containing various default configs
                {
                    'config': ...,
                    'system_prompts': ...,
                    'kontext_presets': ...
                }
        """
        try:
            results = {}
            
            # 1. Update config.json
            if 'config' in default_configs:
                results['config_update'] = self._update_config_json(default_configs['config'])
                
            # 2. Update system_prompts.json
            if 'system_prompts' in default_configs:
                results['system_prompts_update'] = self._update_json_file(
                    os.path.join(self.rules_dir, "system_prompts.json"),
                    default_configs['system_prompts'],
                    "system_prompts"
                )
                
            # active_prompts.json and tags_user.json don't need incremental updates
            # (simple structure, no version management needed)
                 
            # 5. Update kontext_presets.json
            if 'kontext_presets' in default_configs:
                results['kontext_presets_update'] = self._update_json_file(
                    os.path.join(self.rules_dir, "kontext_presets.json"),
                    default_configs['kontext_presets'],
                    "kontext_presets"
                )
                
            return results
            
        except Exception as e:
            self._log(f"Incremental update failed: {str(e)}")
            return {}

    def _update_config_json(self, default_config):
        """
        Handle incremental updates for config.json (with version checking)

        Merge strategy (unified with other config files):
        1. Version comparison
        2. Root-level fields: use generic _deep_merge_defaults to fill in missing fields
        3. model_services: match by id, only fill in missing fields for user's existing services (do not append new services)
        4. Sync version number after completion
        """
        user_config_path = os.path.join(self.config_dir, "config.json")
        if not os.path.exists(user_config_path):
            return False
            
        try:
            with open(user_config_path, 'r', encoding='utf-8') as f:
                user_config = json.load(f)
            
            # Get version numbers
            template_version = default_config.get('__config_version', '2.0')
            user_version = user_config.get('__config_version')  # No default value

            # If user file has no version number, just add the version number (silently skip)
            if user_version is None:
                user_config = {'__config_version': template_version, **user_config}
                with open(user_config_path, 'w', encoding='utf-8') as f:
                    json.dump(user_config, f, ensure_ascii=False, indent=2)
                return True
            
            # Version comparison: skip when template version <= user version
            cmp_result = self._compare_versions(template_version, user_version)
            if cmp_result <= 0:
                return False

            import copy

            # 1. Root-level field completion (exclude model_services, handled separately)
            for key, value in default_config.items():
                if key == "model_services":
                    continue  # model_services handled separately
                if key not in user_config:
                    user_config[key] = copy.deepcopy(value)
                    self._log(f"[config.json] Added missing root field: {key}")
                elif isinstance(value, dict) and isinstance(user_config[key], dict):
                    # Recursively merge nested dicts (e.g. baidu_translate, current_services)
                    self._deep_merge_defaults(user_config[key], value)

            # 2. Merge model_services by id
            self._merge_model_services(user_config, default_config)

            # Update version number (rebuild dict to ensure version number is at the beginning)
            user_config = {'__config_version': template_version, **{k: v for k, v in user_config.items() if k != '__config_version'}}
            
            with open(user_config_path, 'w', encoding='utf-8') as f:
                json.dump(user_config, f, ensure_ascii=False, indent=2)
            self._log(f"[config.json] Incremental update complete (v{user_version} -> v{template_version})")
            return True

        except Exception as e:
            self._log(f"[config.json] Update check error: {str(e)}")
            return False

    def _merge_model_services(self, user_config, default_config):
        """
        Merge model_services by id (full strategy)

        Strategy:
        - Fill in missing fields for user's existing services
        - Append service providers from template that don't exist in user config (new providers from version updates)
        - Do not overwrite llm_models/vlm_models (user-customized model lists)
        """
        if 'model_services' not in default_config:
            return
        
        if 'model_services' not in user_config:
            user_config['model_services'] = []
        
        # Build user service id set
        user_service_ids = {s.get('id') for s in user_config['model_services'] if s.get('id')}

        import copy

        # 1. Fill in missing fields for user's existing services
        template_services_map = {
            s.get('id'): s for s in default_config['model_services'] if s.get('id')
        }
        
        for user_service in user_config['model_services']:
            service_id = user_service.get('id')
            if not service_id or service_id not in template_services_map:
                continue
            
            template_service = template_services_map[service_id]
            service_name = user_service.get('name', service_id)
            
            # Fill in missing service-level fields
            for key, value in template_service.items():
                if key in ['llm_models', 'vlm_models']:
                    # Do not fill model lists (user-customized)
                    continue
                if key not in user_service:
                    user_service[key] = copy.deepcopy(value)
                    self._log(f"[config.json] Added missing field for service '{service_name}': {key}")

        # 2. Append service providers from template that don't exist in user config
        for template_service in default_config['model_services']:
            service_id = template_service.get('id')
            if not service_id or service_id in user_service_ids:
                continue
            
            # Append new service provider
            new_service = copy.deepcopy(template_service)
            user_config['model_services'].append(new_service)
            self._log(f"[config.json] Appended new service provider: {new_service.get('name', service_id)}")

    def _update_json_file(self, file_path, default_data, file_desc):
        """
        Generic JSON file incremental update (with version checking)

        Logic:
        1. Check if user file has a version number
        2. If no version number, just add the current template version number (skip incremental update)
        3. If version number exists, compare template version with user version
        4. Only execute incremental update when template version > user version
        5. Sync user version number after incremental update
        """
        if not os.path.exists(file_path):
            return False
            
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                user_data = json.load(f)
            
            # Get version numbers
            template_version = default_data.get('__config_version', '2.0')
            user_version = user_data.get('__config_version')  # No default value

            # If user file has no version number, just add the version number (silently handled)
            if user_version is None:
                user_data = {'__config_version': template_version, **user_data}
                self._save_with_version(file_path, user_data, default_data)
                return True
            
            # Version comparison: skip when template version <= user version
            cmp_result = self._compare_versions(template_version, user_version)
            if cmp_result <= 0:
                return False

            # Execute deep merge
            modified = self._deep_merge_defaults(user_data, default_data)

            # ---Special handling: overwrite system_prompts rule content---
            if file_desc == "system_prompts":
                modified = self._overwrite_prompts_from_template(user_data, default_data) or modified

            # ---Special handling: fill in category and showIn fields for all rules in system_prompts---
            if file_desc == "system_prompts":
                modified = self._ensure_prompts_have_category(user_data) or modified
                modified = self._ensure_prompts_have_show_in(user_data) or modified

            # Regardless of field changes, version number must be updated (rebuild dict to ensure version number is at the beginning)
            user_data = {'__config_version': template_version, **{k: v for k, v in user_data.items() if k != '__config_version'}}
            
            with open(file_path, 'w', encoding='utf-8') as f:
                json.dump(user_data, f, ensure_ascii=False, indent=2)
            self._log(f"[{file_desc}.json] Incremental update complete (v{user_version} -> v{template_version})")
            return True

        except Exception as e:
            self._log(f"[{file_desc}.json] Update check error: {str(e)}")
            return False
    
    def _ensure_prompts_have_category(self, system_prompts_data):
        """
        Ensure all rules in system_prompts have a category field

        For all rule types (expand_prompts, vision_prompts, video_prompts),
        fill in the category field (default value is empty string) for each rule.

        Returns whether any modifications were made.
        """
        modified = False

        # Rule types to process
        prompt_types = ['expand_prompts', 'vision_prompts', 'video_prompts']

        for prompt_type in prompt_types:
            if prompt_type not in system_prompts_data:
                continue

            prompts = system_prompts_data[prompt_type]
            if not isinstance(prompts, dict):
                continue

            for prompt_id, prompt_data in prompts.items():
                if not isinstance(prompt_data, dict):
                    continue

                # Fill in category field for rules
                if 'category' not in prompt_data:
                    prompt_data['category'] = ''
                    modified = True

        return modified

    def _ensure_prompts_have_show_in(self, system_prompts_data):
        """
        Ensure all rules in system_prompts have a showIn field

        For all rule types (expand_prompts, vision_prompts, video_prompts),
        fill in the showIn field (default value is ["frontend", "node"]) for each rule.

        Returns whether any modifications were made.
        """
        modified = False

        # Rule types to process
        prompt_types = ['expand_prompts', 'vision_prompts', 'video_prompts']

        for prompt_type in prompt_types:
            if prompt_type not in system_prompts_data:
                continue

            prompts = system_prompts_data[prompt_type]
            if not isinstance(prompts, dict):
                continue

            for prompt_id, prompt_data in prompts.items():
                if not isinstance(prompt_data, dict):
                    continue

                # Fill in showIn field for rules
                if 'showIn' not in prompt_data:
                    prompt_data['showIn'] = ["frontend", "node"]
                    modified = True

        return modified

    def _overwrite_prompts_from_template(self, user_data, template_data):
        """
        Overwrite rules in user config with template rule content of the same name

        When version updates occur (template version > user version), completely overwrite
        the corresponding rules in user config with template rule content to ensure
        built-in rules stay up to date.

        Overwrite strategy:
        - Only overwrite rules that exist in both template and user config
        - User-customized rules (not in template) remain unchanged
        - New rules in template are handled by _deep_merge_defaults

        Returns whether any modifications were made.
        """
        import copy
        modified = False

        # Rule types to process
        prompt_types = ['expand_prompts', 'vision_prompts', 'video_prompts', 'translate_prompts']

        for prompt_type in prompt_types:
            # Check if template has this type
            if prompt_type not in template_data:
                continue

            template_prompts = template_data[prompt_type]
            if not isinstance(template_prompts, dict):
                continue

            # Check if user config has this type
            if prompt_type not in user_data:
                continue

            user_prompts = user_data[prompt_type]
            if not isinstance(user_prompts, dict):
                continue

            # Iterate through each rule in template
            for prompt_id, template_prompt in template_prompts.items():
                if not isinstance(template_prompt, dict):
                    continue

                # Check if user config has a rule with the same name
                if prompt_id in user_prompts:
                    # Completely overwrite user rule with template content
                    user_prompts[prompt_id] = copy.deepcopy(template_prompt)
                    modified = True
                    self._log(f"[system_prompts] Overwritten rule: {template_prompt.get('name', prompt_id)}")

        return modified

    def _deep_merge_defaults(self, user_data, default_data):
        """
        Recursively merge missing fields from default_data into user_data

        Merge strategy:
        - dict: recursively merge, fill in missing keys
        - list: append new elements from template that don't exist in user list

        Returns whether any modifications were made.
        """
        modified = False
        import copy

        # ---Handle dict type---
        if isinstance(user_data, dict) and isinstance(default_data, dict):
            for key, value in default_data.items():
                if key not in user_data:
                    # Field doesn't exist, add directly
                    user_data[key] = copy.deepcopy(value)
                    modified = True
                else:
                    # Field exists, check recursively
                    if self._deep_merge_defaults(user_data[key], value):
                        modified = True

        # ---Handle list type---
        elif isinstance(user_data, list) and isinstance(default_data, list):
            # Append elements from template list that don't exist in user list
            for item in default_data:
                if item not in user_data:
                    user_data.append(copy.deepcopy(item))
                    modified = True

        return modified
    
    def migrate_tags_json_to_csv(self):
        """
        Migrate legacy JSON tags to CSV format

        Migration logic:
        1. Check if tags directory is empty
        2. If empty, read tags.json and tags_user.json from plugin config directory
        3. tags.json -> convert to "default_tags.csv"
        4. tags_user.json -> convert to "user_tags.csv"

        CSV format: tag_name\ttag_value\tcategory_1\tcategory_2\tcategory_3\tcategory_4
        """
        try:
            # 1. Check if migration is needed
            if not self._should_migrate_tags():
                return False

            # 2. Read JSON files
            tags_data, user_tags_data = self._load_legacy_tags_json()

            migrated_count = 0

            # ---Process tags.json -> default_tags.csv---
            if tags_data:
                csv_rows = []
                self._extract_tags_recursive(tags_data, [], csv_rows)

                if csv_rows:
                    csv_filename = "default_tags.csv"
                    self._write_tags_csv(csv_rows, csv_filename)
                    self._log(f"[tags.json] Successfully migrated {len(csv_rows)} tags to {csv_filename}")
                    migrated_count += len(csv_rows)

            # ---Process tags_user.json -> user_tags.csv---
            if user_tags_data:
                csv_rows = []
                # tags_user.json has 2-level structure: {category: {tag_name: tag_value}}
                for category, tags in user_tags_data.items():
                    if not isinstance(tags, dict):
                        continue

                    for tag_name, tag_value in tags.items():
                        # CSV row: [tag_name, tag_value, category_1, category_2, category_3, category_4]
                        row = [
                            tag_name,
                            tag_value,
                            category,
                            "",  # category_2 (empty)
                            "",  # category_3 (empty)
                            ""   # category_4 (empty)
                        ]
                        csv_rows.append(row)

                if csv_rows:
                    csv_filename = "user_tags.csv"
                    self._write_tags_csv(csv_rows, csv_filename)
                    self._log(f"[tags_user.json] Successfully migrated {len(csv_rows)} tags to {csv_filename}")
                    migrated_count += len(csv_rows)

            # ---If both files don't exist, try creating default tags from template---
            if not tags_data and not user_tags_data:
                template_path = os.path.join(self.plugin_dir, "config", "tags_template.json")
                if os.path.exists(template_path):
                    try:
                        with open(template_path, 'r', encoding='utf-8') as f:
                            template_data = json.load(f)

                        csv_rows = []
                        self._extract_tags_recursive(template_data, [], csv_rows)

                        if csv_rows:
                            csv_filename = "default_tags.csv"
                            self._write_tags_csv(csv_rows, csv_filename)
                            self._log(f"✨ Fresh environment detected, created initial tags file from template: {csv_filename}")
                            return True
                    except Exception as e:
                        self._log(f"Failed to create initial tags from template: {str(e)}")

                # Last resort when template read fails or doesn't exist
                csv_rows = [["Welcome to Prompt Assistant", "", "Guide", "Getting Started", "", ""]]
                csv_filename = "default_tags.csv"
                self._write_tags_csv(csv_rows, csv_filename)
                self._log(f"✨ Created simple initial tags file: {csv_filename}")
                return True

            return migrated_count > 0

        except Exception as e:
            self._log(f"[tags] Tags migration failed: {str(e)}")
            return False
    
    def _should_migrate_tags(self):
        """Check if tags migration is needed"""
        # Check if tags directory exists
        if not os.path.exists(self.tags_dir):
            return True

        # Check if there are CSV files
        try:
            csv_files = [f for f in os.listdir(self.tags_dir) if f.endswith('.csv')]
            return len(csv_files) == 0
        except Exception:
            return True
    
    def _load_legacy_tags_json(self):
        """
        Load legacy JSON tag files

        Returns:
            (tags_data, user_tags_data) tuple
        """
        tags_data = None
        user_tags_data = None

        # Read tags.json
        legacy_tags_path = os.path.join(self.legacy_config_dir, "tags.json")
        if os.path.exists(legacy_tags_path):
            try:
                with open(legacy_tags_path, 'r', encoding='utf-8') as f:
                    tags_data = json.load(f)
            except Exception as e:
                self._log(f"Failed to read tags.json: {str(e)}")

        # Read tags_user.json
        legacy_user_tags_path = os.path.join(self.legacy_config_dir, "tags_user.json")
        if os.path.exists(legacy_user_tags_path):
            try:
                with open(legacy_user_tags_path, 'r', encoding='utf-8') as f:
                    user_tags_data = json.load(f)
            except Exception as e:
                self._log(f"Failed to read tags_user.json: {str(e)}")

        return tags_data, user_tags_data
    
    def _extract_tags_recursive(self, data, categories, csv_rows):
        """
        Recursively extract tag data

        Determines whether it's a category or tag based on nesting depth:
        - If the value is a string, it's a tag (key=tag_name, value=tag_value)
        - If the value is a dict, it's a category, continue recursing

        Args:
            data: Data dict at the current level
            categories: List of categories on the current path (up to 4 levels)
            csv_rows: Result list for collecting CSV rows
        """
        for key, value in data.items():
            if isinstance(value, str):
                # Value is a string, meaning current key is tag_name and value is tag_value
                # Build CSV row: [tag_name, tag_value, category_1, category_2, category_3, category_4]
                row = [key, value]

                # Fill categories (4 levels total, pad with empty strings if insufficient)
                for i in range(4):
                    if i < len(categories):
                        row.append(categories[i])
                    else:
                        row.append("")

                csv_rows.append(row)

            elif isinstance(value, dict):
                # Value is a dict, meaning current key is a category name, continue recursing
                # Limit to 4 category levels, ignore deeper levels
                if len(categories) < 4:
                    new_categories = categories + [key]
                    self._extract_tags_recursive(value, new_categories, csv_rows)
                else:
                    # Exceeded 4 category levels, log warning and skip
                    self._log(f"Category nesting exceeds 4 levels, ignored: {' -> '.join(categories)} -> {key}")
    
    def _write_tags_csv(self, csv_rows, filename):
        """
        Write CSV file

        Args:
            csv_rows: CSV row data
            filename: File name
        """
        csv_path = os.path.join(self.tags_dir, filename)

        # Ensure directory exists
        os.makedirs(self.tags_dir, exist_ok=True)

        # Write CSV file (using utf-8-sig encoding for Excel compatibility)
        with open(csv_path, 'w', newline='', encoding='utf-8-sig') as f:
            writer = csv.writer(f)
            # Write header
            writer.writerow(['tag_name', 'tag_value', 'category_1', 'category_2', 'category_3', 'category_4'])
            # Write data
            writer.writerows(csv_rows)
    
    # --- Config.json Migration ---

    def migrate_config_api_keys(self):
        """
        Migrate API Keys from legacy config.json to new config format

        Migration logic:
        1. Check if config.json exists in user config directory
        2. If not, read config.json from plugin config directory
        3. Extract API Keys and migrate to new config (v2.0 model_services format)

        Extracted API Keys:
        - baidu_translate: app_id, secret_key
        - llm.providers: api_key for zhipu, siliconflow, custom
        - vlm.providers: api_key for zhipu, siliconflow, custom
        """
        try:
            # 1. Check if migration is needed
            user_config_path = os.path.join(self.config_dir, "config.json")
            if os.path.exists(user_config_path):
                return False

            # 2. Read legacy config.json
            legacy_config_path = os.path.join(self.legacy_config_dir, "config.json")
            if not os.path.exists(legacy_config_path):
                return False

            # 3. Load legacy config
            with open(legacy_config_path, 'r', encoding='utf-8') as f:
                legacy_config = json.load(f)

            self._log(f"[config.json] Found legacy config, preparing migration to v2.0 format")

            # 4. Save complete legacy config to temp file for config_manager to convert
            migration_data_path = os.path.join(self.config_dir, ".migration_legacy_config.json")
            os.makedirs(self.config_dir, exist_ok=True)

            with open(migration_data_path, 'w', encoding='utf-8') as f:
                json.dump(legacy_config, f, ensure_ascii=False, indent=2)

            return True

        except Exception as e:
            self._log(f"config.json migration failed: {str(e)}")
            return False
    
    def _extract_api_keys_from_legacy_config(self, legacy_config):
        """
        Extract API Keys from legacy config.json

        Args:
            legacy_config: Legacy config dictionary

        Returns:
            Dictionary of extracted API Keys
        """
        api_keys = {}

        # Extract Baidu Translate config
        if 'baidu_translate' in legacy_config:
            baidu = legacy_config['baidu_translate']
            if baidu.get('app_id') or baidu.get('secret_key'):
                api_keys['baidu_translate'] = {
                    'app_id': baidu.get('app_id', ''),
                    'secret_key': baidu.get('secret_key', '')
                }
                self._log("Extracted Baidu Translate config")

        # Extract LLM API Keys
        if 'llm' in legacy_config and 'providers' in legacy_config['llm']:
            llm_providers = legacy_config['llm']['providers']
            api_keys['llm'] = {}

            for provider_name in ['zhipu', 'siliconflow', 'custom']:
                if provider_name in llm_providers:
                    api_key = llm_providers[provider_name].get('api_key', '')
                    if api_key:
                        api_keys['llm'][provider_name] = api_key
                        self._log(f"Extracted LLM {provider_name} API Key")

        # Extract VLM API Keys
        if 'vlm' in legacy_config and 'providers' in legacy_config['vlm']:
            vlm_providers = legacy_config['vlm']['providers']
            api_keys['vlm'] = {}

            for provider_name in ['zhipu', 'siliconflow', 'custom']:
                if provider_name in vlm_providers:
                    api_key = vlm_providers[provider_name].get('api_key', '')
                    if api_key:
                        api_keys['vlm'][provider_name] = api_key
                        self._log(f"Extracted VLM {provider_name} API Key")

        return api_keys


def run_migrations(plugin_dir, user_base_dir, logger=None, default_configs=None):
    """
    Run all migration tasks

    Execution order:
    1. Ensure all config files exist (create/migrate if missing)
    2. Execute legacy API Key migration
    3. Execute incremental updates (on demand after version comparison)

    Args:
        plugin_dir: Plugin directory path
        user_base_dir: User config base directory
        logger: Log function (optional)
        default_configs: Default config dictionary (for creating default files and incremental updates)

    Returns:
        Migration results dictionary
    """
    tool = MigrationTool(plugin_dir, user_base_dir, logger)
    legacy_dir = os.path.join(plugin_dir, "config")

    results = {
        'configs_created': False,
        'tags_migration': False,
        'config_migration': False,
        'incremental_updates': {}
    }

    # 1. Ensure all config files exist
    if default_configs:
        tool.ensure_all_configs_exist(default_configs, legacy_dir)
        results['configs_created'] = True

    # 2. Execute legacy API Key migration
    results['config_migration'] = tool.migrate_config_api_keys()
    results['tags_migration'] = tool.migrate_tags_json_to_csv()

    # 3. Execute incremental updates (on demand after version comparison)
    if default_configs:
        results['incremental_updates'] = tool.migrate_incremental_updates(default_configs)

    return results
