/**
 * Help-center snippets for a fictional platform.
 *
 * The corpus is built out of tight clusters: a dozen sentences that say almost
 * the same thing and differ only in one qualifier (which region, which plan,
 * which kind of log). Their embeddings land nearly on top of each other, so
 * cosine can order the cluster but not really tell its members apart. Reading
 * the question and a candidate together is what separates them, which is the
 * whole argument for a reranker.
 */

export const documents: ReadonlyArray<string> = [
  // Log retention: region x log type. Question 1 lands in here.
  "Audit logs are kept for 400 days in the US region.",
  "Audit logs are kept for 180 days in the EU region.",
  "Audit logs are kept for 90 days in the AP region.",
  "Application logs are kept for 30 days in the US region.",
  "Application logs are kept for 14 days in the EU region.",
  "Access logs are kept for 7 days in every region.",
  "Build logs are kept for 30 days in every region.",
  "Audit log exports are kept for 30 days after they are generated.",
  "Audit log retention on Enterprise can be extended to three years in any region.",
  "Audit log retention cannot be shortened below the floor for your region.",
  "Streaming audit logs to your own bucket has no retention limit in any region.",
  "Deleted projects keep their audit logs for the remainder of the regional window.",
  "Log search covers the last 7 days unless you pass an explicit date range.",
  "Region is fixed when the organisation is created and cannot be changed later.",
  "EU region data is stored in Frankfurt and never leaves the European Union.",
  "AP region data is stored in Singapore.",

  // Rollback: plan tier x what is being rolled back. Question 2 lands here.
  "Roll back a deployment on Enterprise from the deployment history page.",
  "Roll back a deployment on Scale from the deployment history page.",
  "Roll back a deployment on Team from the deployment history page.",
  "On the free tier there is no deployment history, so roll back by redeploying an earlier commit from your Git provider.",
  "Roll back a database migration with the migrations CLI, not the deployment history page.",
  "Roll back an environment variable change from the project settings audit trail.",
  "Rolling back a deployment does not roll back a database migration.",
  "Deployment history holds the last 50 builds on Scale and the last 10 on Team.",
  "The free tier keeps only the build that is currently live.",
  "The free tier builds automatically from your connected branch on every push.",
  "A failed build never replaces the running deployment.",
  "Promoting a preview deployment to production is available on Team and above.",
  "Instant rollback swaps the previous build back in without a rebuild.",

  // Priority support: billing term x plan. Question 3 lands here.
  "Priority support is included on Enterprise at no extra cost.",
  "Priority support is included on Scale when you commit to an annual plan.",
  "Priority support is included on Team when you commit to an annual plan.",
  "Priority support can be bought as a month-to-month add-on on any plan, with no annual commitment.",
  "Standard support is included on every plan and answers within two business days.",
  "Priority support answers within four business hours.",
  "Enterprise support answers within one business hour.",
  "Support response times start when a ticket is acknowledged, not when it is filed.",
  "Annual commitments cut the per-seat price by 20% across Team and Scale.",
  "Moving off an annual plan takes effect at the end of the current term.",
  "Credits from an annual plan do not roll over into the next term.",
  "Support add-ons are billed separately from seats.",

  // Single sign-on and provisioning.
  "SAML single sign-on is available on Scale and Enterprise.",
  "OIDC single sign-on is available on Enterprise only.",
  "SCIM provisioning is available on Enterprise only.",
  "Just-in-time user provisioning is available on Scale and Enterprise.",
  "Enforced two-factor authentication is available on every paid plan.",
  "Directory sync runs every 30 minutes on Enterprise.",
  "Single sign-on cannot be combined with password login once it is enforced.",

  // API tokens and access.
  "Personal API tokens expire after 90 days.",
  "Organisation API tokens expire after 365 days.",
  "Deploy tokens do not expire but are scoped to one project.",
  "API tokens inherit the permissions of whoever created them.",
  "Revoking a member's access invalidates their API tokens immediately.",
  "Service accounts count as seats on Team but not on Enterprise.",
  "Rotating an API token does not interrupt running deployments.",

  // Quotas, limits, and overage.
  "The API rate limit is 100 requests per minute on Team.",
  "The API rate limit is 1,000 requests per minute on Scale.",
  "The API rate limit is negotiated per contract on Enterprise.",
  "The API rate limit is 20 requests per minute on the free tier.",
  "Build concurrency is one job on the free tier and Team.",
  "Build concurrency is five jobs on Scale.",
  "Overage on Team is billed monthly in arrears at the standard per-unit rate.",
  "Overage is not available on the free tier; requests are rejected at the limit.",
  "Quotas reset on the first day of each billing period, not on a rolling window.",
  "Build minutes are shared across an organisation rather than per project.",

  // Domains and networking.
  "Custom domains require a CNAME record.",
  "Apex domains additionally require ALIAS or ANAME support from your DNS provider.",
  "Wildcard domains are available on Scale and Enterprise.",
  "TLS certificates are issued automatically and renew 30 days before expiry.",
  "Edge caching is on by default; set a Cache-Control header to opt out per route.",
  "Custom domains are limited to one on the free tier.",

  // Backups.
  "Database backups are taken daily on Team and kept for 7 days.",
  "Database backups are taken hourly on Scale and kept for 30 days.",
  "Database backups are taken continuously on Enterprise with point-in-time restore.",
  "The free tier takes no database backups.",
  "Restoring a backup creates a new database rather than overwriting the current one.",

  // Billing.
  "Invoices are issued in USD, or in EUR for organisations registered in the EU.",
  "A payment failure pauses new deployments but leaves running ones untouched.",
  "Seats are billed per active member per month.",
  "Removing a member frees their seat at the end of the billing period.",
  "Annual invoices are issued once, up front, for the whole term.",

  // Notifications.
  "Deployment failure alerts can be sent to email, Slack, or a webhook.",
  "Quota alerts fire at 80% and 100% of the period's allowance.",
  "Incident notifications are sent to organisation owners only.",
  "Webhook deliveries are retried for 24 hours before they are dropped.",
]

/**
 * Demo questions. Each names a qualifier (a region, a plan, a kind of log)
 * that only one document in its cluster satisfies.
 */
export const questions: ReadonlyArray<string> = [
  "How long are audit logs kept in the EU region?",
  "How do I roll back a deployment on the free tier?",
  "Can I get priority support without committing to an annual plan?",
]
