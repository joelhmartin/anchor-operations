/**
 * Cross-platform correlator rules — Phase 6.
 *
 * Each rule consumes a `checks` array (one entry per ops_check_results row for
 * a run) and produces an ops_findings row when `when()` returns truthy.
 *
 * Rule shape:
 *   {
 *     name: string,                                  // unique rule name
 *     category: string,                              // ops_findings.category — `correlation.<name>`
 *     severity: 'critical' | 'warning' | 'info',
 *     when({ checks }): boolean,
 *     summary({ checks }): string,                   // plain text, no PHI
 *     evidence({ checks }): object,                  // serializable JSON
 *     linkedCheckResultIds({ checks }): string[]     // uuid[]
 *   }
 *
 * Helpers below keep `when`/`evidence`/`linkedCheckResultIds` terse.
 */

function findCheck(checks, checkId) {
  return checks.find((c) => c.check_id === checkId);
}

function findChecks(checks, predicate) {
  return checks.filter(predicate);
}

function isFail(c) {
  return c && (c.status === 'fail' || c.severity === 'critical');
}

function isWarnOrFail(c) {
  return c && (c.status === 'fail' || c.status === 'warn' || c.severity === 'critical' || c.severity === 'warning');
}

function payload(c) {
  return (c && c.payload_json) || {};
}

function ids(...rows) {
  return rows.filter(Boolean).map((r) => r.id).filter(Boolean);
}

const RULES = [
  {
    name: 'tracking_loss_with_conversion_drop',
    category: 'correlation.tracking_loss_with_conversion_drop',
    severity: 'critical',
    when({ checks }) {
      const conv = findCheck(checks, 'gads.conversion_tag.firing');
      const inst = findCheck(checks, 'web.tracking_install');
      return isFail(conv) && inst && payload(inst).gtm_present === false;
    },
    summary() {
      return 'Google Ads conversion tag is not firing AND GTM is missing from the homepage. Likely a tag-deployment regression — fix tracking before optimizing campaigns.';
    },
    evidence({ checks }) {
      const conv = findCheck(checks, 'gads.conversion_tag.firing');
      const inst = findCheck(checks, 'web.tracking_install');
      return {
        gads_conversion_status: conv?.status,
        gads_conversion_payload: payload(conv),
        web_tracking_install_payload: payload(inst)
      };
    },
    linkedCheckResultIds({ checks }) {
      return ids(findCheck(checks, 'gads.conversion_tag.firing'), findCheck(checks, 'web.tracking_install'));
    }
  },

  {
    name: 'psi_lcp_regression_with_organic_traffic_drop',
    category: 'correlation.psi_lcp_regression_with_organic_traffic_drop',
    severity: 'warning',
    when({ checks }) {
      const psi = findCheck(checks, 'web.psi');
      const traf = findCheck(checks, 'web.semrush.organic_traffic_drop');
      const psiPayload = payload(psi);
      const lcpRegressed = psiPayload?.mobile?.lcp_regressed === true || psiPayload?.lcp_regressed === true;
      return lcpRegressed && isWarnOrFail(traf);
    },
    summary() {
      return 'Mobile LCP regressed on PSI AND organic traffic dropped on SEMrush — page-experience signal is correlating with rankings, not just a metric blip.';
    },
    evidence({ checks }) {
      const psi = findCheck(checks, 'web.psi');
      const traf = findCheck(checks, 'web.semrush.organic_traffic_drop');
      return { psi_payload: payload(psi), semrush_payload: payload(traf) };
    },
    linkedCheckResultIds({ checks }) {
      return ids(findCheck(checks, 'web.psi'), findCheck(checks, 'web.semrush.organic_traffic_drop'));
    }
  },

  {
    name: 'meta_capi_down_with_lead_form_active',
    category: 'correlation.meta_capi_down_with_lead_form_active',
    severity: 'critical',
    when({ checks }) {
      const capi = findCheck(checks, 'meta.capi.health');
      const inst = findCheck(checks, 'web.tracking_install');
      // Lead form active is approximated by tracking-install reporting a Meta
      // pixel present (means a Meta lead event surface exists on the site).
      const metaSurfaceActive = inst && payload(inst).meta_pixel_present === true;
      return isFail(capi) && metaSurfaceActive;
    },
    summary() {
      return 'Meta CAPI is failing while the site still has the Meta pixel deployed. Lead-form events from this site are likely being lost server-side.';
    },
    evidence({ checks }) {
      const capi = findCheck(checks, 'meta.capi.health');
      const inst = findCheck(checks, 'web.tracking_install');
      return { capi_payload: payload(capi), tracking_install_payload: payload(inst) };
    },
    linkedCheckResultIds({ checks }) {
      return ids(findCheck(checks, 'meta.capi.health'), findCheck(checks, 'web.tracking_install'));
    }
  },

  {
    name: 'ssl_expiring_with_organic_decline',
    category: 'correlation.ssl_expiring_with_organic_decline',
    severity: 'warning',
    when({ checks }) {
      const ssl30 = findCheck(checks, 'web.ssl.expiry_within_30d');
      const ssl7 = findCheck(checks, 'web.ssl.expiry_within_7d');
      const traf = findCheck(checks, 'web.semrush.organic_traffic_drop');
      const expiringSoon = isFail(ssl30) || isFail(ssl7);
      return expiringSoon && isWarnOrFail(traf);
    },
    summary() {
      return 'SSL certificate is expiring soon AND organic traffic is dropping. Renew the cert before search engines downgrade trust signals further.';
    },
    evidence({ checks }) {
      const ssl30 = findCheck(checks, 'web.ssl.expiry_within_30d');
      const ssl7 = findCheck(checks, 'web.ssl.expiry_within_7d');
      const traf = findCheck(checks, 'web.semrush.organic_traffic_drop');
      return { ssl_30d_payload: payload(ssl30), ssl_7d_payload: payload(ssl7), semrush_payload: payload(traf) };
    },
    linkedCheckResultIds({ checks }) {
      return ids(
        findCheck(checks, 'web.ssl.expiry_within_30d'),
        findCheck(checks, 'web.ssl.expiry_within_7d'),
        findCheck(checks, 'web.semrush.organic_traffic_drop')
      );
    }
  },

  {
    name: 'keyword_ranking_drop_with_indexation_errors',
    category: 'correlation.keyword_ranking_drop_with_indexation_errors',
    severity: 'warning',
    when({ checks }) {
      const kw = findCheck(checks, 'gads.keywords.position_changes');
      const cov = findCheck(checks, 'web.gsc.coverage_errors');
      return isWarnOrFail(kw) && isWarnOrFail(cov);
    },
    summary() {
      return 'Keyword positions are slipping AND GSC reports coverage errors. Indexation problems are likely the upstream cause — fix coverage before bidding higher.';
    },
    evidence({ checks }) {
      return {
        gads_keywords_payload: payload(findCheck(checks, 'gads.keywords.position_changes')),
        gsc_coverage_payload: payload(findCheck(checks, 'web.gsc.coverage_errors'))
      };
    },
    linkedCheckResultIds({ checks }) {
      return ids(
        findCheck(checks, 'gads.keywords.position_changes'),
        findCheck(checks, 'web.gsc.coverage_errors')
      );
    }
  },

  {
    name: 'budget_overrun_with_disapproved_ads',
    category: 'correlation.budget_overrun_with_disapproved_ads',
    severity: 'critical',
    when({ checks }) {
      const budget = findCheck(checks, 'gads.account.budget_pacing');
      const disapproved = findCheck(checks, 'gads.account.disapproved_ads');
      return isWarnOrFail(budget) && isWarnOrFail(disapproved);
    },
    summary() {
      return 'Budget pacing is off AND disapproved ads are present on the account. Spend may be concentrating on a narrowed surviving ad set — fix disapprovals to restore breadth.';
    },
    evidence({ checks }) {
      return {
        budget_payload: payload(findCheck(checks, 'gads.account.budget_pacing')),
        disapproved_payload: payload(findCheck(checks, 'gads.account.disapproved_ads'))
      };
    },
    linkedCheckResultIds({ checks }) {
      return ids(
        findCheck(checks, 'gads.account.budget_pacing'),
        findCheck(checks, 'gads.account.disapproved_ads')
      );
    }
  },

  {
    name: 'meta_pixel_dedup_failure_with_capi_match_low',
    category: 'correlation.meta_pixel_dedup_failure_with_capi_match_low',
    severity: 'warning',
    when({ checks }) {
      const dedup = findCheck(checks, 'meta.pixel.deduplication');
      const match = findCheck(checks, 'meta.capi.match_quality');
      return isWarnOrFail(dedup) && isWarnOrFail(match);
    },
    summary() {
      return 'Meta pixel deduplication is failing AND CAPI match quality is low. Server and browser events are not being unified — Meta is overcounting or losing attribution.';
    },
    evidence({ checks }) {
      return {
        dedup_payload: payload(findCheck(checks, 'meta.pixel.deduplication')),
        match_payload: payload(findCheck(checks, 'meta.capi.match_quality'))
      };
    },
    linkedCheckResultIds({ checks }) {
      return ids(
        findCheck(checks, 'meta.pixel.deduplication'),
        findCheck(checks, 'meta.capi.match_quality')
      );
    }
  },

  {
    name: 'gtm_missing_with_kinsta_drift',
    category: 'correlation.gtm_missing_with_kinsta_drift',
    severity: 'critical',
    when({ checks }) {
      const inst = findCheck(checks, 'web.tracking_install');
      const drift = findCheck(checks, 'web.kinsta.drift');
      const gtmMissing = inst && payload(inst).gtm_present === false;
      // Drift check fails or warns when there are recent unaccepted changes.
      return gtmMissing && isWarnOrFail(drift);
    },
    summary() {
      return 'GTM is missing from the homepage AND Kinsta drift detected recent server-side changes. A deployment likely stripped the tracking snippet.';
    },
    evidence({ checks }) {
      return {
        tracking_install_payload: payload(findCheck(checks, 'web.tracking_install')),
        kinsta_drift_payload: payload(findCheck(checks, 'web.kinsta.drift'))
      };
    },
    linkedCheckResultIds({ checks }) {
      return ids(findCheck(checks, 'web.tracking_install'), findCheck(checks, 'web.kinsta.drift'));
    }
  },

  {
    name: 'experiments_stale_with_disapproved_ads',
    category: 'correlation.experiments_stale_with_disapproved_ads',
    severity: 'warning',
    when({ checks }) {
      const exp = findCheck(checks, 'gads.account.experiments.active');
      const disapproved = findCheck(checks, 'gads.account.disapproved_ads');
      return isWarnOrFail(exp) && isWarnOrFail(disapproved);
    },
    summary() {
      return 'Active Google Ads experiments are running while disapproved ads are present. Experiment results will be polluted — pause experiments or fix disapprovals first.';
    },
    evidence({ checks }) {
      return {
        experiments_payload: payload(findCheck(checks, 'gads.account.experiments.active')),
        disapproved_payload: payload(findCheck(checks, 'gads.account.disapproved_ads'))
      };
    },
    linkedCheckResultIds({ checks }) {
      return ids(
        findCheck(checks, 'gads.account.experiments.active'),
        findCheck(checks, 'gads.account.disapproved_ads')
      );
    }
  },

  {
    name: 'domain_unverified_with_active_meta_spend',
    category: 'correlation.domain_unverified_with_active_meta_spend',
    severity: 'critical',
    when({ checks }) {
      const dv = findCheck(checks, 'meta.account.domain_verification');
      // "Active Meta spend" is approximated by any Meta delivery / pixel signal
      // present and non-skipped.
      const metaActive = findChecks(
        checks,
        (c) => c.umbrella === 'meta' && c.status !== 'skipped'
      ).length > 0;
      return isFail(dv) && metaActive;
    },
    summary() {
      return 'Meta domain verification has not been completed for an account that is actively spending. iOS attribution is degraded until the domain is verified.';
    },
    evidence({ checks }) {
      return {
        domain_verification_payload: payload(findCheck(checks, 'meta.account.domain_verification'))
      };
    },
    linkedCheckResultIds({ checks }) {
      return ids(findCheck(checks, 'meta.account.domain_verification'));
    }
  },

  {
    // V5: turn a failed snapshot.metric_anomaly check into an ops_findings row.
    // The check already ran the deterministic baseline-deviation engine and set
    // its own severity (warning|critical); this rule surfaces that as a finding
    // and mirrors the severity (dynamic) so a critical z-score is not flattened
    // to a warning.
    name: 'snapshot_metric_anomaly',
    category: 'correlation.snapshot_metric_anomaly',
    severity({ checks }) {
      const c = findCheck(checks, 'snapshot.metric_anomaly');
      return c?.severity === 'critical' ? 'critical' : 'warning';
    },
    when({ checks }) {
      const c = findCheck(checks, 'snapshot.metric_anomaly');
      return isWarnOrFail(c);
    },
    summary({ checks }) {
      const w = payload(findCheck(checks, 'snapshot.metric_anomaly')).worst;
      if (!w) return 'A tracked metric deviated significantly from its learned baseline.';
      const pct = w.pct_change !== null && w.pct_change !== undefined
        ? ` (${Math.round(w.pct_change * 100)}%)` : '';
      const z = w.z_score !== null && w.z_score !== undefined ? ` z=${w.z_score}` : '';
      return `${w.service} ${w.metric} ${w.direction} vs ${w.period} baseline${pct}${z}: `
           + `observed ${w.observed} vs baseline ${w.baseline_value}. Investigate before it compounds.`;
    },
    evidence({ checks }) {
      return { anomaly_payload: payload(findCheck(checks, 'snapshot.metric_anomaly')) };
    },
    linkedCheckResultIds({ checks }) {
      return ids(findCheck(checks, 'snapshot.metric_anomaly'));
    }
  }
];

export default RULES;
export { RULES };
