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
        处理 config.json 的增量更新 (带版本检查)
        
        合并策略（与其他配置文件统一）:
        1. 版本比对
        2. 根级字段: 使用通用的 _deep_merge_defaults 补全
        3. model_services: 按 id 匹配，只补全用户已有服务的缺失字段（不追加新服务）
        4. 完成后同步版本号
        """
        user_config_path = os.path.join(self.config_dir, "config.json")
        if not os.path.exists(user_config_path):
            return False
            
        try:
            with open(user_config_path, 'r', encoding='utf-8') as f:
                user_config = json.load(f)
            
            # 获取版本号
            template_version = default_config.get('__config_version', '2.0')
            user_version = user_config.get('__config_version')  # 不设默认值
            
            # 如果用户文件没有版本号，只补上版本号（静默跳过）
            if user_version is None:
                user_config = {'__config_version': template_version, **user_config}
                with open(user_config_path, 'w', encoding='utf-8') as f:
                    json.dump(user_config, f, ensure_ascii=False, indent=2)
                return True
            
            # 版本比对：模板版本 <= 用户版本时跳过
            cmp_result = self._compare_versions(template_version, user_version)
            if cmp_result <= 0:
                return False
            
            import copy
            
            # 1. 根级字段补全（排除 model_services，单独处理）
            for key, value in default_config.items():
                if key == "model_services":
                    continue  # model_services 单独处理
                if key not in user_config:
                    user_config[key] = copy.deepcopy(value)
                    self._log(f"[config.json] 补全根字段: {key}")
                elif isinstance(value, dict) and isinstance(user_config[key], dict):
                    # 递归合并嵌套字典（如 baidu_translate、current_services）
                    self._deep_merge_defaults(user_config[key], value)
            
            # 2. model_services 按 id 匹配合并
            self._merge_model_services(user_config, default_config)
            
            # 更新版本号（重构字典确保版本号在开头）
            user_config = {'__config_version': template_version, **{k: v for k, v in user_config.items() if k != '__config_version'}}
            
            with open(user_config_path, 'w', encoding='utf-8') as f:
                json.dump(user_config, f, ensure_ascii=False, indent=2)
            self._log(f"[config.json] 增量更新已完成 (v{user_version} -> v{template_version})")
            return True
            
        except Exception as e:
            self._log(f"[config.json] 更新检查出错: {str(e)}")
            return False

    def _merge_model_services(self, user_config, default_config):
        """
        按 id 匹配合并 model_services（完整策略）
        
        策略:
        - 补全用户已有服务的缺失字段
        - 追加模板中用户不存在的服务商（版本更新时的新服务商）
        - 不覆盖 llm_models/vlm_models（用户自定义的模型列表）
        """
        if 'model_services' not in default_config:
            return
        
        if 'model_services' not in user_config:
            user_config['model_services'] = []
        
        # 构建用户服务的 id 集合
        user_service_ids = {s.get('id') for s in user_config['model_services'] if s.get('id')}
        
        import copy
        
        # 1. 补全用户已有服务的缺失字段
        template_services_map = {
            s.get('id'): s for s in default_config['model_services'] if s.get('id')
        }
        
        for user_service in user_config['model_services']:
            service_id = user_service.get('id')
            if not service_id or service_id not in template_services_map:
                continue
            
            template_service = template_services_map[service_id]
            service_name = user_service.get('name', service_id)
            
            # 补全服务级别的缺失字段
            for key, value in template_service.items():
                if key in ['llm_models', 'vlm_models']:
                    # 模型列表不补全（用户自定义）
                    continue
                if key not in user_service:
                    user_service[key] = copy.deepcopy(value)
                    self._log(f"[config.json] 补全服务 '{service_name}' 字段: {key}")
        
        # 2. 追加模板中用户不存在的服务商
        for template_service in default_config['model_services']:
            service_id = template_service.get('id')
            if not service_id or service_id in user_service_ids:
                continue
            
            # 追加新服务商
            new_service = copy.deepcopy(template_service)
            user_config['model_services'].append(new_service)
            self._log(f"[config.json] 追加新服务商: {new_service.get('name', service_id)}")

    def _update_json_file(self, file_path, default_data, file_desc):
        """
        通用的 JSON 文件增量更新 (带版本检查)
        
        逻辑:
        1. 检查用户文件是否有版本号
        2. 如果没有版本号，只补上当前模板版本号（跳过增量更新）
        3. 如果有版本号，比对模板版本和用户版本
        4. 仅当模板版本 > 用户版本时执行增量
        5. 增量完成后同步用户版本号
        """
        if not os.path.exists(file_path):
            return False
            
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                user_data = json.load(f)
            
            # 获取版本号
            template_version = default_data.get('__config_version', '2.0')
            user_version = user_data.get('__config_version')  # 不设默认值
            
            # 如果用户文件没有版本号，只补上版本号（静默处理）
            if user_version is None:
                user_data = {'__config_version': template_version, **user_data}
                self._save_with_version(file_path, user_data, default_data)
                return True
            
            # 版本比对：模板版本 <= 用户版本时跳过
            cmp_result = self._compare_versions(template_version, user_version)
            if cmp_result <= 0:
                return False
            
            # 执行深度合并
            modified = self._deep_merge_defaults(user_data, default_data)
            
            # ---特殊处理：system_prompts 规则内容覆盖---
            if file_desc == "system_prompts":
                modified = self._overwrite_prompts_from_template(user_data, default_data) or modified
            
            # ---特殊处理：为 system_prompts 中的所有规则补全 category 和 showIn 字段---
            if file_desc == "system_prompts":
                modified = self._ensure_prompts_have_category(user_data) or modified
                modified = self._ensure_prompts_have_show_in(user_data) or modified
            
            # 无论是否有字段变更，都需要更新版本号（重构字典确保版本号在开头）
            user_data = {'__config_version': template_version, **{k: v for k, v in user_data.items() if k != '__config_version'}}
            
            with open(file_path, 'w', encoding='utf-8') as f:
                json.dump(user_data, f, ensure_ascii=False, indent=2)
            self._log(f"[{file_desc}.json] 增量更新已完成 (v{user_version} -> v{template_version})")
            return True
                
        except Exception as e:
            self._log(f"[{file_desc}.json] 更新检查出错: {str(e)}")
            return False
    
    def _ensure_prompts_have_category(self, system_prompts_data):
        """
        确保 system_prompts 中的所有规则都有 category 字段
        
        为所有规则类型（expand_prompts、vision_prompts、video_prompts）中的每个规则
        补全 category 字段（默认值为空字符串）
        
        返回是否发生了修改
        """
        modified = False
        
        # 需要处理的规则类型
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
                    
                # 为规则补全 category 字段
                if 'category' not in prompt_data:
                    prompt_data['category'] = ''
                    modified = True
        
        return modified

    def _ensure_prompts_have_show_in(self, system_prompts_data):
        """
        确保 system_prompts 中的所有规则都有 showIn 字段
        
        为所有规则类型（expand_prompts、vision_prompts、video_prompts）中的每个规则
        补全 showIn 字段（默认值为 ["frontend", "node"]）
        
        返回是否发生了修改
        """
        modified = False
        
        # 需要处理的规则类型
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
                    
                # 为规则补全 showIn 字段
                if 'showIn' not in prompt_data:
                    prompt_data['showIn'] = ["frontend", "node"]
                    modified = True
        
        return modified

    def _overwrite_prompts_from_template(self, user_data, template_data):
        """
        用模板中的规则内容覆盖用户配置中的同名规则
        
        当版本更新时（模板版本 > 用户版本），将模板中的规则内容
        完整覆盖到用户配置中的对应规则，确保内置规则保持最新。
        
        覆盖策略:
        - 仅覆盖模板和用户配置中都存在的同名规则
        - 用户自定义的规则（模板中不存在）保持不变
        - 模板中新增的规则由 _deep_merge_defaults 处理
        
        返回是否发生了修改
        """
        import copy
        modified = False
        
        # 需要处理的规则类型
        prompt_types = ['expand_prompts', 'vision_prompts', 'video_prompts', 'translate_prompts']
        
        for prompt_type in prompt_types:
            # 检查模板中是否有该类型
            if prompt_type not in template_data:
                continue
            
            template_prompts = template_data[prompt_type]
            if not isinstance(template_prompts, dict):
                continue
            
            # 检查用户配置中是否有该类型
            if prompt_type not in user_data:
                continue
            
            user_prompts = user_data[prompt_type]
            if not isinstance(user_prompts, dict):
                continue
            
            # 遍历模板中的每个规则
            for prompt_id, template_prompt in template_prompts.items():
                if not isinstance(template_prompt, dict):
                    continue
                
                # 检查用户配置中是否存在同名规则
                if prompt_id in user_prompts:
                    # 用模板内容完整覆盖用户规则
                    user_prompts[prompt_id] = copy.deepcopy(template_prompt)
                    modified = True
                    self._log(f"[system_prompts] 覆盖规则: {template_prompt.get('name', prompt_id)}")
        
        return modified

    def _deep_merge_defaults(self, user_data, default_data):
        """
        递归将 default_data 中的缺失字段合并到 user_data
        
        合并策略:
        - dict: 递归合并，补全缺失的键
        - list: 将模板中不存在于用户列表的新元素追加到末尾
        
        返回是否发生了修改
        """
        modified = False
        import copy
        
        # ---处理字典类型---
        if isinstance(user_data, dict) and isinstance(default_data, dict):
            for key, value in default_data.items():
                if key not in user_data:
                    # 字段不存在，直接添加
                    user_data[key] = copy.deepcopy(value)
                    modified = True
                else:
                    # 字段存在，递归检查
                    if self._deep_merge_defaults(user_data[key], value):
                        modified = True
        
        # ---处理数组类型---
        elif isinstance(user_data, list) and isinstance(default_data, list):
            # 将模板数组中不存在于用户数组的元素追加到末尾
            for item in default_data:
                if item not in user_data:
                    user_data.append(copy.deepcopy(item))
                    modified = True
                        
        return modified
    
    def migrate_tags_json_to_csv(self):
        """
        迁移旧版 JSON 标签到 CSV 格式
        
        迁移逻辑:
        1. 检查 tags 目录是否为空
        2. 如果为空，读取插件 config 目录下的 tags.json 和 tags_user.json
        3. tags.json → 转换为 "默认标签.csv"
        4. tags_user.json → 转换为 "用户标签.csv"
        
        CSV 格式: 标签名\t标签值\t一级分类\t二级分类\t三级分类\t四级分类
        """
        try:
            # 1. 检查是否需要迁移
            if not self._should_migrate_tags():
                return False
            
            # 2. 读取 JSON 文件
            tags_data, user_tags_data = self._load_legacy_tags_json()
            
            migrated_count = 0
            
            # ---处理 tags.json → 默认标签.csv---
            if tags_data:
                csv_rows = []
                self._extract_tags_recursive(tags_data, [], csv_rows)
                
                if csv_rows:
                    csv_filename = "默认标签.csv"
                    self._write_tags_csv(csv_rows, csv_filename)
                    self._log(f"[tags.json] ✅ 成功迁移 {len(csv_rows)} 个标签到 {csv_filename}")
                    migrated_count += len(csv_rows)
            
            # ---处理 tags_user.json → 用户标签.csv---
            if user_tags_data:
                csv_rows = []
                # tags_user.json 是2层结构: {分类: {标签名: 标签值}}
                for category, tags in user_tags_data.items():
                    if not isinstance(tags, dict):
                        continue
                    
                    for tag_name, tag_value in tags.items():
                        # CSV 行: [标签名, 标签值, 一级分类, 二级分类, 三级分类, 四级分类]
                        row = [
                            tag_name,
                            tag_value,
                            category,
                            "",  # 二级分类（空）
                            "",  # 三级分类（空）
                            ""   # 四级分类（空）
                        ]
                        csv_rows.append(row)
                
                if csv_rows:
                    csv_filename = "用户标签.csv"
                    self._write_tags_csv(csv_rows, csv_filename)
                    self._log(f"[tags_user.json] ✅ 成功迁移 {len(csv_rows)} 个标签到 {csv_filename}")
                    migrated_count += len(csv_rows)
            
            # ---如果两个文件都不存在，尝试从模板创建默认标签---
            if not tags_data and not user_tags_data:
                template_path = os.path.join(self.plugin_dir, "config", "tags_template.json")
                if os.path.exists(template_path):
                    try:
                        with open(template_path, 'r', encoding='utf-8') as f:
                            template_data = json.load(f)
                        
                        csv_rows = []
                        self._extract_tags_recursive(template_data, [], csv_rows)
                        
                        if csv_rows:
                            csv_filename = "默认标签.csv"
                            self._write_tags_csv(csv_rows, csv_filename)
                            self._log(f"✨ 检测到全新环境，已基于模板创建初始标签文件: {csv_filename}")
                            return True
                    except Exception as e:
                        self._log(f"❗ 从模板创建初始标签失败: {str(e)}")
                
                # 模板读取失败或不存在时的最后保底
                csv_rows = [["欢迎使用提示词小助手", "", "指南", "开始", "", ""]]
                csv_filename = "默认标签.csv"
                self._write_tags_csv(csv_rows, csv_filename)
                self._log(f"✨ 已创建简易初始标签文件: {csv_filename}")
                return True
            
            return migrated_count > 0
            
        except Exception as e:
            self._log(f"[tags] ❗ 标签迁移失败: {str(e)}")
            return False
    
    def _should_migrate_tags(self):
        """检查是否需要迁移标签"""
        # 检查 tags 目录是否存在
        if not os.path.exists(self.tags_dir):
            return True
        
        # 检查是否有 CSV 文件
        try:
            csv_files = [f for f in os.listdir(self.tags_dir) if f.endswith('.csv')]
            return len(csv_files) == 0
        except Exception:
            return True
    
    def _load_legacy_tags_json(self):
        """
        加载旧版 JSON 标签文件
        
        返回:
            (tags_data, user_tags_data) 元组
        """
        tags_data = None
        user_tags_data = None
        
        # 读取 tags.json
        legacy_tags_path = os.path.join(self.legacy_config_dir, "tags.json")
        if os.path.exists(legacy_tags_path):
            try:
                with open(legacy_tags_path, 'r', encoding='utf-8') as f:
                    tags_data = json.load(f)
            except Exception as e:
                self._log(f"❗ 读取 tags.json 失败: {str(e)}")
        
        # 读取 tags_user.json
        legacy_user_tags_path = os.path.join(self.legacy_config_dir, "tags_user.json")
        if os.path.exists(legacy_user_tags_path):
            try:
                with open(legacy_user_tags_path, 'r', encoding='utf-8') as f:
                    user_tags_data = json.load(f)
            except Exception as e:
                self._log(f"❗ 读取 tags_user.json 失败: {str(e)}")
        
        return tags_data, user_tags_data
    
    def _extract_tags_recursive(self, data, categories, csv_rows):
        """
        递归提取标签数据
        
        根据嵌套深度判断是分类还是标签：
        - 如果值是字符串，则为标签（键=标签名，值=标签值）
        - 如果值是字典，则为分类，继续递归
        
        参数:
            data: 当前层级的数据字典
            categories: 当前路径上的分类列表（最多4级）
            csv_rows: 结果列表，用于收集CSV行
        """
        for key, value in data.items():
            if isinstance(value, str):
                # 值是字符串，说明当前键是标签名，值是标签值
                # 构建CSV行：[标签名, 标签值, 一级分类, 二级分类, 三级分类, 四级分类]
                row = [key, value]
                
                # 填充分类（共4级，不足的补空字符串）
                for i in range(4):
                    if i < len(categories):
                        row.append(categories[i])
                    else:
                        row.append("")
                
                csv_rows.append(row)
            
            elif isinstance(value, dict):
                # 值是字典，说明当前键是分类名，继续递归
                # 限制最多4级分类，超过则忽略更深层级
                if len(categories) < 4:
                    new_categories = categories + [key]
                    self._extract_tags_recursive(value, new_categories, csv_rows)
                else:
                    # 超过4级分类，记录警告并跳过
                    self._log(f"⚠️ 分类层级超过4级，已忽略: {' → '.join(categories)} → {key}")
    
    def _write_tags_csv(self, csv_rows, filename):
        """
        写入 CSV 文件
        
        参数:
            csv_rows: CSV 行数据
            filename: 文件名
        """
        csv_path = os.path.join(self.tags_dir, filename)
        
        # 确保目录存在
        os.makedirs(self.tags_dir, exist_ok=True)
        
        # 写入 CSV 文件（使用 utf-8-sig 编码，兼容 Excel）
        with open(csv_path, 'w', newline='', encoding='utf-8-sig') as f:
            writer = csv.writer(f)
            # 写入表头
            writer.writerow(['标签名', '标签值', '一级分类', '二级分类', '三级分类', '四级分类'])
            # 写入数据
            writer.writerows(csv_rows)
    
    # --- Config.json 迁移 ---
    
    def migrate_config_api_keys(self):
        """
        迁移旧版 config.json 中的 API Key 到新版配置
        
        迁移逻辑:
        1. 检查用户配置目录的 config.json 是否存在
        2. 如果不存在，读取插件 config 目录下的 config.json
        3. 提取 API Key 并迁移到新版配置（v2.0 model_services 格式）
        
        提取的 API Key:
        - baidu_translate: app_id, secret_key
        - llm.providers: zhipu, siliconflow, custom 的 api_key
        - vlm.providers: zhipu, siliconflow, custom 的 api_key
        """
        try:
            # 1. 检查是否需要迁移
            user_config_path = os.path.join(self.config_dir, "config.json")
            if os.path.exists(user_config_path):
                return False
            
            # 2. 读取旧版 config.json
            legacy_config_path = os.path.join(self.legacy_config_dir, "config.json")
            if not os.path.exists(legacy_config_path):
                return False
            
            # 3. 加载旧版配置
            with open(legacy_config_path, 'r', encoding='utf-8') as f:
                legacy_config = json.load(f)
            
            self._log(f"[config.json] 找到旧版配置，准备迁移到 v2.0 格式")
            
            # 4. 将完整的旧版配置保存到临时文件，供 config_manager 转换
            migration_data_path = os.path.join(self.config_dir, ".migration_legacy_config.json")
            os.makedirs(self.config_dir, exist_ok=True)
            
            with open(migration_data_path, 'w', encoding='utf-8') as f:
                json.dump(legacy_config, f, ensure_ascii=False, indent=2)
            
            return True
            
        except Exception as e:
            self._log(f"❗ config.json 迁移失败: {str(e)}")
            return False
    
    def _extract_api_keys_from_legacy_config(self, legacy_config):
        """
        从旧版 config.json 提取 API Key
        
        参数:
            legacy_config: 旧版配置字典
        
        返回:
            提取的 API Key 字典
        """
        api_keys = {}
        
        # 提取百度翻译配置
        if 'baidu_translate' in legacy_config:
            baidu = legacy_config['baidu_translate']
            if baidu.get('app_id') or baidu.get('secret_key'):
                api_keys['baidu_translate'] = {
                    'app_id': baidu.get('app_id', ''),
                    'secret_key': baidu.get('secret_key', '')
                }
                self._log("提取百度翻译配置")
        
        # 提取 LLM API Key
        if 'llm' in legacy_config and 'providers' in legacy_config['llm']:
            llm_providers = legacy_config['llm']['providers']
            api_keys['llm'] = {}
            
            for provider_name in ['zhipu', 'siliconflow', 'custom']:
                if provider_name in llm_providers:
                    api_key = llm_providers[provider_name].get('api_key', '')
                    if api_key:
                        api_keys['llm'][provider_name] = api_key
                        self._log(f"提取 LLM {provider_name} API Key")
        
        # 提取 VLM API Key
        if 'vlm' in legacy_config and 'providers' in legacy_config['vlm']:
            vlm_providers = legacy_config['vlm']['providers']
            api_keys['vlm'] = {}
            
            for provider_name in ['zhipu', 'siliconflow', 'custom']:
                if provider_name in vlm_providers:
                    api_key = vlm_providers[provider_name].get('api_key', '')
                    if api_key:
                        api_keys['vlm'][provider_name] = api_key
                        self._log(f"提取 VLM {provider_name} API Key")
        
        return api_keys


def run_migrations(plugin_dir, user_base_dir, logger=None, default_configs=None):
    """
    运行所有迁移任务
    
    执行顺序:
    1. 确保所有配置文件存在（缺则创建/迁移）
    2. 执行旧版 API Key 迁移
    3. 执行增量更新（版本比对后按需执行）
    
    参数:
        plugin_dir: 插件目录路径
        user_base_dir: 用户配置基础目录
        logger: 日志函数（可选）
        default_configs: 默认配置字典（用于创建默认文件和增量更新）
    
    返回:
        迁移结果字典
    """
    tool = MigrationTool(plugin_dir, user_base_dir, logger)
    legacy_dir = os.path.join(plugin_dir, "config")
    
    results = {
        'configs_created': False,
        'tags_migration': False,
        'config_migration': False,
        'incremental_updates': {}
    }
    
    # 1. 确保所有配置文件存在
    if default_configs:
        tool.ensure_all_configs_exist(default_configs, legacy_dir)
        results['configs_created'] = True
    
    # 2. 执行旧版 API Key 迁移
    results['config_migration'] = tool.migrate_config_api_keys()
    results['tags_migration'] = tool.migrate_tags_json_to_csv()
    
    # 3. 执行增量更新（版本比对后按需执行）
    if default_configs:
        results['incremental_updates'] = tool.migrate_incremental_updates(default_configs)
    
    return results
