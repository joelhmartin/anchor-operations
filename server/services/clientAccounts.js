import { query } from '../db.js';
import { clientLabelSelect, clientLabelJoins } from './clientLabel.js';

const MEMBERSHIP_ROLE_PRIORITY = {
  owner: 3,
  admin: 2,
  member: 1
};

function normalizeMembershipRole(role, fallback = 'member') {
  const value = String(role || '').trim().toLowerCase();
  return MEMBERSHIP_ROLE_PRIORITY[value] ? value : fallback;
}

function membershipPriority(role) {
  return MEMBERSHIP_ROLE_PRIORITY[normalizeMembershipRole(role)] || 0;
}

function buildOwnerName(row) {
  return [row.owner_first_name, row.owner_last_name].filter(Boolean).join(' ').trim() || null;
}

function buildDisplayName(row) {
  return row.client_label || row.business_name || buildOwnerName(row) || row.owner_email;
}

function mapAccountRow(row) {
  return {
    clientOwnerId: row.client_owner_id,
    membershipRole: normalizeMembershipRole(row.membership_role),
    businessName: row.business_name || null,
    displayName: buildDisplayName(row),
    ownerName: buildOwnerName(row),
    ownerEmail: row.owner_email,
    isSelfOwner: Boolean(row.is_self_owner),
    accessScope: row.access_scope || 'direct',
    sourceGroupId: row.source_group_id || null,
    sourceGroupName: row.source_group_name || null
  };
}

function preferCandidateAccount(existing, candidate) {
  const existingPriority = membershipPriority(existing?.membershipRole);
  const candidatePriority = membershipPriority(candidate?.membershipRole);

  if (candidatePriority !== existingPriority) {
    return candidatePriority > existingPriority;
  }

  if (existing?.accessScope !== candidate?.accessScope) {
    return candidate?.accessScope === 'direct';
  }

  return false;
}

function sortAccounts(accounts) {
  return [...accounts].sort((a, b) => {
    const selfSort = Number(a.isSelfOwner) - Number(b.isSelfOwner);
    if (selfSort !== 0) return selfSort;

    const roleSort = membershipPriority(b.membershipRole) - membershipPriority(a.membershipRole);
    if (roleSort !== 0) return roleSort;

    return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' });
  });
}

function mergeAccounts(...accountLists) {
  const deduped = new Map();

  for (const account of accountLists.flat()) {
    const existing = deduped.get(account.clientOwnerId);
    if (!existing || preferCandidateAccount(existing, account)) {
      deduped.set(account.clientOwnerId, account);
    }
  }

  return sortAccounts([...deduped.values()]);
}

async function ensureLegacyOwnerMembership(userId, userRole) {
  if (userRole !== 'client') return;
  const { rows } = await query(
    `SELECT 1 FROM users u
     WHERE u.id = $1
       AND (
         EXISTS (SELECT 1 FROM brand_assets ba WHERE ba.user_id = u.id)
         OR EXISTS (SELECT 1 FROM client_profiles cp WHERE cp.user_id = u.id AND cp.client_identifier_value IS NOT NULL)
         OR EXISTS (
           SELECT 1
           FROM client_account_members cam
           WHERE cam.client_owner_id = u.id
             AND cam.status = 'active'
         )
       )
     LIMIT 1`,
    [userId]
  );
  if (!rows.length) return;

  await query(
    `INSERT INTO client_account_members (client_owner_id, member_user_id, role, status, accepted_at)
     VALUES ($1, $1, 'owner', 'active', NOW())
     ON CONFLICT (client_owner_id, member_user_id) DO NOTHING`,
    [userId]
  );
}

async function fetchDirectActiveClientAccounts(userId) {
  const { rows } = await query(
    `SELECT
       cam.client_owner_id,
       cam.role AS membership_role,
       owner.email AS owner_email,
       owner.first_name AS owner_first_name,
       owner.last_name AS owner_last_name,
       ba.business_name,
       ${clientLabelSelect({ alias: 'client_label', u: 'owner' })},
       (cam.client_owner_id = cam.member_user_id) AS is_self_owner,
       'direct'::text AS access_scope,
       NULL::uuid AS source_group_id,
       NULL::text AS source_group_name
     FROM client_account_members cam
     JOIN users owner ON owner.id = cam.client_owner_id
     ${clientLabelJoins('cam.client_owner_id')}
     WHERE cam.member_user_id = $1
       AND cam.status = 'active'`,
    [userId]
  );

  return rows.map(mapAccountRow);
}

async function fetchGroupDerivedClientAccounts(userId) {
  const { rows } = await query(
    `SELECT
       cp.user_id AS client_owner_id,
       cgm.role AS membership_role,
       owner.email AS owner_email,
       owner.first_name AS owner_first_name,
       owner.last_name AS owner_last_name,
       ba.business_name,
       ${clientLabelSelect({ alias: 'client_label', u: 'owner', cp: 'cp_label' })},
       (cp.user_id = cgm.member_user_id) AS is_self_owner,
       'group'::text AS access_scope,
       cg.id AS source_group_id,
       cg.name AS source_group_name
     FROM client_group_members cgm
     JOIN client_groups cg ON cg.id = cgm.client_group_id
     JOIN client_profiles cp ON cp.client_group_id = cgm.client_group_id
     JOIN users owner ON owner.id = cp.user_id
     ${clientLabelJoins({ userIdExpr: 'cp.user_id', cp: 'cp_label' })}
     WHERE cgm.member_user_id = $1
       AND cgm.status = 'active'
       AND cgm.role IN ('admin', 'member')
       AND (
         EXISTS (SELECT 1 FROM brand_assets ba_owner WHERE ba_owner.user_id = cp.user_id)
         OR cp.client_identifier_value IS NOT NULL
         OR EXISTS (
           SELECT 1
           FROM client_account_members cam_owner
           WHERE cam_owner.client_owner_id = cp.user_id
             AND cam_owner.member_user_id = cp.user_id
             AND cam_owner.status = 'active'
         )
       )`,
    [userId]
  );

  return rows.map(mapAccountRow);
}

export async function listClientAccountsForUser(userId, { userRole } = {}) {
  let directAccounts = await fetchDirectActiveClientAccounts(userId);
  let groupAccounts = await fetchGroupDerivedClientAccounts(userId);

  // Synthesize the legacy self-owner row whenever the user lacks a direct
  // membership. The inner gate inside ensureLegacyOwnerMembership only inserts
  // when the user is an actual client account owner (brand_assets / client_profiles
  // / existing client_account_members), so pure group invitees are never
  // promoted. Don't skip on the basis of group access — group account owners
  // who happen to also be in a group still need their owner row backfilled.
  if (!directAccounts.length && userRole === 'client') {
    await ensureLegacyOwnerMembership(userId, userRole);
    directAccounts = await fetchDirectActiveClientAccounts(userId);
  }

  return mergeAccounts(directAccounts, groupAccounts);
}

export async function resolveActiveClientAccount(userId, requestedClientOwnerId, { userRole } = {}) {
  const accounts = await listClientAccountsForUser(userId, { userRole });
  const requestedId = requestedClientOwnerId ? String(requestedClientOwnerId) : null;
  // Honor an explicit request first. Otherwise auto-select only when there's exactly
  // one account — users with multiple accounts (group members, multi-account invitees)
  // land on an account picker instead of being dropped into whichever sorts first.
  let activeAccount = null;
  if (requestedId) {
    activeAccount = accounts.find((account) => account.clientOwnerId === requestedId) || null;
  }
  if (!activeAccount && accounts.length === 1) {
    activeAccount = accounts[0];
  }
  return { accounts, activeAccount };
}

export async function resolveClientAccountAccess(userId, clientOwnerId, { userRole } = {}) {
  const accounts = await listClientAccountsForUser(userId, { userRole });
  return accounts.find((account) => account.clientOwnerId === String(clientOwnerId)) || null;
}

function mapTeamMemberRow(row) {
  return {
    id: row.id,
    rowKey: row.row_key,
    member_user_id: row.member_user_id,
    role: normalizeMembershipRole(row.role),
    status: row.status,
    invited_at: row.invited_at,
    accepted_at: row.accepted_at,
    email: row.email,
    first_name: row.first_name,
    last_name: row.last_name,
    avatar_url: row.avatar_url,
    invited_by_first_name: row.invited_by_first_name || null,
    invited_by_last_name: row.invited_by_last_name || null,
    isInherited: Boolean(row.is_inherited),
    isEditable: Boolean(row.is_editable),
    sourceGroupId: row.source_group_id || null,
    sourceGroupName: row.source_group_name || null
  };
}

export async function listAccountTeamMembers(clientOwnerId) {
  const [directRes, inheritedRes] = await Promise.all([
    query(
      `SELECT
         cam.id,
         CONCAT('direct:', cam.id::text) AS row_key,
         cam.member_user_id,
         cam.role,
         cam.status,
         cam.invited_at,
         cam.accepted_at,
         u.email,
         u.first_name,
         u.last_name,
         u.avatar_url,
         inviter.first_name AS invited_by_first_name,
         inviter.last_name AS invited_by_last_name,
         FALSE AS is_inherited,
         (cam.role <> 'owner') AS is_editable,
         NULL::uuid AS source_group_id,
         NULL::text AS source_group_name
       FROM client_account_members cam
       JOIN users u ON u.id = cam.member_user_id
       LEFT JOIN users inviter ON inviter.id = cam.invited_by
       WHERE cam.client_owner_id = $1
         AND cam.status = 'active'
       ORDER BY
         CASE cam.role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END,
         cam.accepted_at ASC`,
      [clientOwnerId]
    ),
    query(
      `SELECT
         cgm.id,
         CONCAT('group:', cgm.id::text, ':', cgm.member_user_id::text) AS row_key,
         cgm.member_user_id,
         cgm.role,
         cgm.status,
         cgm.invited_at,
         cgm.accepted_at,
         u.email,
         u.first_name,
         u.last_name,
         u.avatar_url,
         inviter.first_name AS invited_by_first_name,
         inviter.last_name AS invited_by_last_name,
         TRUE AS is_inherited,
         FALSE AS is_editable,
         cg.id AS source_group_id,
         cg.name AS source_group_name
       FROM client_profiles cp_owner
       JOIN client_group_members cgm
         ON cgm.client_group_id = cp_owner.client_group_id
        AND cgm.status = 'active'
       JOIN client_groups cg ON cg.id = cgm.client_group_id
       JOIN users u ON u.id = cgm.member_user_id
       LEFT JOIN users inviter ON inviter.id = cgm.invited_by
       WHERE cp_owner.user_id = $1
         AND cp_owner.client_group_id IS NOT NULL
       ORDER BY
         CASE cgm.role WHEN 'admin' THEN 1 ELSE 2 END,
         cgm.accepted_at ASC`,
      [clientOwnerId]
    )
  ]);

  return [...directRes.rows, ...inheritedRes.rows].map(mapTeamMemberRow);
}

export async function listGroupTeamMembers(groupId) {
  const { rows } = await query(
    `SELECT
       cgm.id,
       CONCAT('group:', cgm.id::text) AS row_key,
       cgm.member_user_id,
       cgm.role,
       cgm.status,
       cgm.invited_at,
       cgm.accepted_at,
       u.email,
       u.first_name,
       u.last_name,
       u.avatar_url,
       inviter.first_name AS invited_by_first_name,
       inviter.last_name AS invited_by_last_name,
       FALSE AS is_inherited,
       (cgm.role IN ('admin', 'member')) AS is_editable,
       cg.id AS source_group_id,
       cg.name AS source_group_name
     FROM client_group_members cgm
     JOIN client_groups cg ON cg.id = cgm.client_group_id
     JOIN users u ON u.id = cgm.member_user_id
     LEFT JOIN users inviter ON inviter.id = cgm.invited_by
     WHERE cgm.client_group_id = $1
       AND cgm.status = 'active'
     ORDER BY
       CASE cgm.role WHEN 'admin' THEN 1 ELSE 2 END,
       cgm.accepted_at ASC`,
    [groupId]
  );

  return rows.map(mapTeamMemberRow);
}

export async function fetchClientGroup(groupId) {
  const { rows } = await query(
    `SELECT id, name, description, color, icon, icon_url, sort_order, created_at, updated_at
     FROM client_groups
     WHERE id = $1
     LIMIT 1`,
    [groupId]
  );
  return rows[0] || null;
}
