import { query } from '../../db.js';
import { clientLabelExpression, clientLabelJoins } from '../clientLabel.js';

/**
 * @deprecated Use clientLabelExpression / clientLabelSelect from ../clientLabel.js.
 * Kept as a thin wrapper because ops.js call sites still reference this name and
 * pass `{ userAlias, profileAlias, brandAlias }`. New code should import directly
 * from clientLabel.js.
 */
export function opsClientLabelExpression({ userAlias = 'u', profileAlias = 'cp', brandAlias = 'ba' } = {}) {
  return clientLabelExpression({ u: userAlias, cp: profileAlias, ba: brandAlias });
}

export function opsClientExistsExpression(clientIdSql) {
  return `EXISTS (
    SELECT 1
      FROM users ops_client_u
      LEFT JOIN client_profiles ops_client_cp ON ops_client_cp.user_id = ops_client_u.id
     WHERE ops_client_u.id = ${clientIdSql}
       AND ops_client_u.role = 'client'
       AND (
         EXISTS (
           SELECT 1
             FROM client_account_members ops_client_cam_owner
            WHERE ops_client_cam_owner.client_owner_id = ops_client_u.id
              AND ops_client_cam_owner.member_user_id = ops_client_u.id
              AND ops_client_cam_owner.role = 'owner'
              AND ops_client_cam_owner.status = 'active'
         )
         OR EXISTS (SELECT 1 FROM brand_assets ops_client_ba_owner WHERE ops_client_ba_owner.user_id = ops_client_u.id)
         OR NULLIF(ops_client_cp.client_identifier_value, '') IS NOT NULL
         OR ops_client_cp.onboarding_completed_at IS NOT NULL
         OR EXISTS (SELECT 1 FROM tracking_configs ops_client_tc_owner WHERE ops_client_tc_owner.user_id = ops_client_u.id)
       )
  )`;
}

export async function listOpsClientRoster() {
  const labelExpr = clientLabelExpression();
  const { rows } = await query(`
    WITH client_accounts AS (
      SELECT DISTINCT u.id AS user_id
        FROM users u
        LEFT JOIN client_profiles cp ON cp.user_id = u.id
       WHERE u.role = 'client'
         AND (
           EXISTS (
             SELECT 1
               FROM client_account_members cam_owner
              WHERE cam_owner.client_owner_id = u.id
                AND cam_owner.member_user_id = u.id
                AND cam_owner.role = 'owner'
                AND cam_owner.status = 'active'
           )
           OR EXISTS (SELECT 1 FROM brand_assets ba_owner WHERE ba_owner.user_id = u.id)
           OR NULLIF(cp.client_identifier_value, '') IS NOT NULL
           OR cp.onboarding_completed_at IS NOT NULL
           OR EXISTS (SELECT 1 FROM tracking_configs tc_owner WHERE tc_owner.user_id = u.id)
         )
    )
    SELECT
      u.id,
      u.id AS user_id,
      u.first_name,
      u.last_name,
      u.email,
      u.role,
      cp.client_identifier_value,
      cp.client_package,
      cp.onboarding_completed_at,
      ba.business_name,
      ${labelExpr} AS client_label,
      tc.id AS tracking_config_id,
      tc.client_type AS tracking_client_type,
      tc.client_type,
      tc.website_domain,
      tc.ga4_property_id,
      tc.ga4_measurement_id,
      tc.google_ads_customer_id,
      tc.meta_ad_account_id,
      tc.meta_pixel_id,
      tc.browser_meta_pixel_enabled
    FROM client_accounts ca
    JOIN users u ON u.id = ca.user_id
    ${clientLabelJoins()}
    LEFT JOIN tracking_configs tc ON tc.user_id = u.id
    ORDER BY LOWER(${labelExpr})
  `);
  return rows;
}
