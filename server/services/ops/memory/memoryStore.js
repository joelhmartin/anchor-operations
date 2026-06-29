/**
 * DB layer for curated per-client agent memory (F3, §2.9). The extraction logic
 * (what is worth remembering) lives in clientFactsExtractor.js (pure); this module
 * only persists. Learned facts gain confidence on repeat; manual notes are pinned.
 */
import { query } from '../../../db.js';

export async function upsertMemoryFact({
  clientUserId, scope = 'client', fact_type, fact_key, fact_value = {},
  confidence = 0.5, occurrences = 1, source = 'learned'
}) {
  const { rows } = await query(
    `INSERT INTO ops_agent_memory
       (client_user_id, scope, fact_type, fact_key, fact_value, confidence, occurrences, source)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
     ON CONFLICT (client_user_id, scope, fact_type, fact_key)
     DO UPDATE SET occurrences = GREATEST(ops_agent_memory.occurrences, EXCLUDED.occurrences),
                   last_seen_at = NOW(),
                   fact_value = EXCLUDED.fact_value,
                   confidence = GREATEST(ops_agent_memory.confidence, EXCLUDED.confidence),
                   status = 'active'
     RETURNING *`,
    [clientUserId, scope, fact_type, fact_key, JSON.stringify(fact_value), confidence, occurrences, source]
  );
  return rows[0];
}

export async function getMemory({ clientUserId, scope, factType, status = 'active' } = {}) {
  const { rows } = await query(
    `SELECT * FROM ops_agent_memory
      WHERE client_user_id = $1
        AND ($2::text IS NULL OR status = $2)
        AND ($3::text IS NULL OR scope = $3)
        AND ($4::text IS NULL OR fact_type = $4)
      ORDER BY confidence DESC, last_seen_at DESC`,
    [clientUserId, status ?? null, scope ?? null, factType ?? null]
  );
  return rows;
}

export async function archiveMemoryFact({ id, clientUserId }) {
  const { rows } = await query(
    `UPDATE ops_agent_memory
        SET status = 'archived'
      WHERE id = $1 AND client_user_id = $2
      RETURNING *`,
    [id, clientUserId]
  );
  return rows[0] || null;
}

export async function recordManualNote({ clientUserId, scope = 'client', text, createdBy = null }) {
  const fact_key = `note:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const { rows } = await query(
    `INSERT INTO ops_agent_memory
       (client_user_id, scope, fact_type, fact_key, fact_value, confidence, occurrences, source, created_by)
     VALUES ($1,$2,'manual_note',$3,$4::jsonb,1.0,1,'manual',$5)
     RETURNING *`,
    [clientUserId, scope, fact_key, JSON.stringify({ text }), createdBy]
  );
  return rows[0];
}
