# Pub/Sub topology for the ops orchestration system — Phase 2.
#
# Terraform is NOT yet wired into this repo's CI; this file documents the
# resource shape. Until tf is bootstrapped, apply manually with the gcloud
# commands inlined below.
#
# Manual bootstrap (one-time, applied 2026-05-05 — verify via
# `gcloud pubsub topics list --project=anchor-hub-480305`):
#
#   gcloud pubsub topics create ops.run.requested --project=anchor-hub-480305
#   gcloud pubsub topics create ops.run.completed --project=anchor-hub-480305
#   gcloud pubsub topics create ops.run.cancel    --project=anchor-hub-480305
#   gcloud pubsub topics create ops.run.dead      --project=anchor-hub-480305
#
#   gcloud pubsub subscriptions create ops-runner \
#     --topic=ops.run.requested \
#     --ack-deadline=600 \
#     --dead-letter-topic=ops.run.dead \
#     --max-delivery-attempts=5 \
#     --project=anchor-hub-480305
#
#   gcloud pubsub subscriptions create ops-runner-cancel \
#     --topic=ops.run.cancel \
#     --ack-deadline=60 \
#     --project=anchor-hub-480305
#
#   # DLQ alert (TODO Phase 8 — wire to PagerDuty / email):
#   gcloud alpha monitoring policies create \
#     --notification-channels=<channel-id> \
#     --display-name="ops.run.dead has messages" \
#     --condition-display-name="DLQ depth > 0" \
#     --condition-filter='resource.type="pubsub_topic" AND
#                         resource.labels.topic_id="ops.run.dead" AND
#                         metric.type="pubsub.googleapis.com/topic/num_unacked_messages_by_region"'

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

variable "project_id" {
  type    = string
  default = "anchor-hub-480305"
}

resource "google_pubsub_topic" "ops_run_requested" {
  name    = "ops.run.requested"
  project = var.project_id
}

resource "google_pubsub_topic" "ops_run_completed" {
  name    = "ops.run.completed"
  project = var.project_id
}

resource "google_pubsub_topic" "ops_run_cancel" {
  name    = "ops.run.cancel"
  project = var.project_id
}

resource "google_pubsub_topic" "ops_run_dead" {
  name    = "ops.run.dead"
  project = var.project_id
}

resource "google_pubsub_subscription" "ops_runner" {
  name    = "ops-runner"
  topic   = google_pubsub_topic.ops_run_requested.name
  project = var.project_id

  ack_deadline_seconds = 600

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.ops_run_dead.id
    max_delivery_attempts = 5
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }
}

resource "google_pubsub_subscription" "ops_runner_cancel" {
  name    = "ops-runner-cancel"
  topic   = google_pubsub_topic.ops_run_cancel.name
  project = var.project_id

  ack_deadline_seconds = 60
}
