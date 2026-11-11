/**
 * Column classes of every epoch'd table (authority-epochs.md section 1.1). Each column is in exactly
 * one class: a bump set (one per epoch), volatile (never moves an epoch) or fixed (immutable after
 * insert, guarded by a trigger). `authority-columns.test.ts` checks this against the live schema and
 * the migrated triggers. `conditional` columns bump only once they are set.
 */
export interface EpochTable {
  table: string;
  /** epoch column -> the columns whose change moves it */
  epochs: Record<string, string[]>;
  conditional?: string[];
  volatile: string[];
  fixed: string[];
  /** The package that adds this table's bump trigger; WP0 ships only its guards. */
  bumpTriggerBy?: string;
}

const passBump = [
  'org_id',
  'identity_id',
  'serial',
  'template_id',
  'template_version',
  'auth_token',
  'download_token',
  'web_service_url',
  'personalization',
  'field_sources',
  'display_title',
  'display_subtitle',
  'external_id',
  'holder_email',
  'owner_user_id',
  'status',
  'version',
  'revision',
  'object_key',
  'deleted_at',
  'modified_at',
  'connection_id',
  'external_ref',
  'link_generation',
  'mode',
  'barcode_hash',
  'scan_code',
  'removed_at',
  'lookup_hash',
  'removal_message',
  'removal_prior_status',
  'test_data_quarantined',
  'lifecycle_generation',
  'removal_published_generation',
  'removal_claim_version',
  'removal_claim_status',
  'removal_claim_object_key',
  'removal_claim_link_generation',
  'release_id',
  'credential_generation',
  'image_generation',
];

export const EPOCH_TABLES: EpochTable[] = [
  {
    table: 'orgs',
    epochs: {
      access_revision: ['status'],
      config_revision: ['name', 'slug', 'branding', 'default_identity_id'],
    },
    volatile: ['updated_at', 'branding_dirty_at'],
    fixed: ['id', 'created_at'],
  },
  {
    table: 'users',
    epochs: { access_revision: ['status'] },
    volatile: ['id', 'name', 'primary_email', 'created_at', 'last_login_at', 'last_roles'],
    fixed: [],
  },
  {
    table: 'passes',
    epochs: { row_version: passBump },
    conditional: ['scan_code', 'barcode_hash', 'lookup_hash'],
    volatile: [
      'next_sync_at',
      'last_synced_at',
      'sync_error_code',
      'sync_failures',
      'refresh_requested_at',
      'last_refreshed_at',
      'modified_collision',
      'pending_cause',
      'pending_actor_type',
      'pending_actor_id',
      'pending_pass_json',
      'pending_source',
      'object_sha256',
      'object_size',
      'content_hash',
      'download_token_rotated_at',
    ],
    fixed: ['id', 'created_at', 'created_by'],
  },
  {
    table: 'scanners',
    epochs: {
      credential_epoch: [
        'token_hash',
        'token_prefix',
        'csrf_secret',
        'revoked_at',
        'expires_at',
        'org_id',
        'mode',
        'kind',
        'pair_code_hash',
        'paired_at',
      ],
      config_epoch: ['device_role', 'event_id', 'settings', 'time_zone'],
    },
    volatile: [
      'name',
      'last_seen_at',
      'last_ip_prefix',
      'paired_label',
      'pair_expires_at',
      'pair_created_by',
      'staff_id',
      'staff_since',
      'staff_seen_at',
      'updated_at',
    ],
    // `id` is guarded by scanners_id_immutable (0047).
    fixed: ['id', 'created_at', 'created_by'],
  },
  {
    table: 'scan_staff',
    epochs: { auth_epoch: ['role', 'pin_hash', 'pin_set_at', 'disabled_at', 'org_id'] },
    volatile: ['name', 'updated_at'],
    fixed: ['id', 'created_at', 'created_by'],
  },
  {
    table: 'scan_events',
    epochs: {
      config_epoch: [
        'match_input',
        'match_values',
        'opens_at',
        'closes_at',
        'time_zone',
        'capacity',
        'reentry',
        'archived_at',
        'org_id',
        'mode',
      ],
    },
    volatile: ['name', 'note', 'expected', 'expected_at', 'updated_at'],
    fixed: ['id', 'created_at', 'created_by'],
  },
  {
    table: 'scanning_sessions',
    epochs: { config_epoch: ['status', 'accepts', 'settings', 'time_zone', 'org_id', 'mode'] },
    volatile: ['name', 'updated_at'],
    fixed: ['id', 'created_at', 'created_by'],
  },
  {
    table: 'connections',
    epochs: {
      generation: [
        'enabled',
        'mode',
        'org_id',
        'connector_type',
        'connector_version',
        'config',
        'credential_id',
        'webhook_credential_id',
        'mapping',
        'default_template_id',
        'holder_email_field',
        'auto_create',
        'auto_email',
        'on_missing',
      ],
    },
    volatile: [
      'name',
      'interval_seconds',
      'max_concurrency',
      'requests_per_minute',
      'health',
      'consecutive_failures',
      'breaker_open_until',
      'cursor',
      'next_run_at',
      'last_run_at',
      'last_success_at',
      'last_error_code',
      'last_error_at',
      'updated_at',
    ],
    fixed: ['id', 'created_at'],
  },
];
