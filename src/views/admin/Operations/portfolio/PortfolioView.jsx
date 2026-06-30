/**
 * PortfolioView — cross-client home inside the Operations shell.
 *
 * Two tabs:
 *   • "Bulk & automation" — the existing BulkTab (Runs / Schedules / Skills / Recipes sub-tabs)
 *   • "Cost" — CostTab: per-client MTD spend, tier breakdown, sub-agent costs, cap editing
 *
 * Cost shape (from /api/ops/cost-summary):
 *   Array of { client_user_id, client_name, mtd_cents, cap_cents, runs_count,
 *              by_tier: { daily_essential, weekly_deep, monthly_audit },
 *              by_subagent: { [name]: cents } }
 * Rendered by the existing CostTab component (src/views/admin/Operations/Cost/CostTab.jsx).
 */

import { useState } from 'react';
import { Box, Tabs, Tab } from '@mui/material';
import BulkTab from '../Bulk/BulkTab';
import CostTab from '../Cost/CostTab';
import AccessAuditTab from './AccessAuditTab';

export default function PortfolioView() {
  const [tab, setTab] = useState('access');

  return (
    <Box>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
        <Tab value="access" label="Access Audit" />
        <Tab value="bulk" label="Bulk & automation" />
        <Tab value="cost" label="Cost" />
      </Tabs>
      {tab === 'access' ? <AccessAuditTab /> : tab === 'bulk' ? <BulkTab /> : <CostTab />}
    </Box>
  );
}
