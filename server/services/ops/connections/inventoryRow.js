/**
 * Canonical ops_platform_inventory row builder. Validates required keys,
 * stringifies external ids, and fills the optional fields with null/{} so
 * every connector emits an identical shape (spec §2.3).
 */
export function inventoryRow(fields = {}) {
  const {
    object_type,
    external_id,
    name = null,
    status = null,
    parent_external_id = null,
    url = null,
    metadata = {}
  } = fields;

  if (!object_type) throw new Error('inventoryRow: object_type required');
  if (external_id == null || external_id === '') throw new Error('inventoryRow: external_id required');

  return {
    object_type: String(object_type),
    external_id: String(external_id),
    name: name == null ? null : String(name),
    status: status == null ? null : String(status),
    parent_external_id: parent_external_id == null ? null : String(parent_external_id),
    url: url == null ? null : String(url),
    metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}
  };
}
