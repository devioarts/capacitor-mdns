const base = require('@ionic/swiftlint-config');

module.exports = {
  ...base,
  cache_path: '${PWD}/.swiftlint-cache',
  disabled_rules: [...(base.disabled_rules ?? []), 'file_length', 'identifier_name', 'type_name'],
  excluded: [...base.excluded, '${PWD}/.build', '${PWD}/node_modules'],
};
