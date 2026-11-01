-- List and search indexes. LIKE is case-insensitive, so prefix searches only use NOCASE indexes.
CREATE INDEX passes_title_nc ON passes (display_title COLLATE NOCASE);
CREATE INDEX passes_subtitle_nc ON passes (display_subtitle COLLATE NOCASE);
CREATE INDEX passes_external_nc ON passes (external_id COLLATE NOCASE);
CREATE INDEX passes_holder_nc ON passes (holder_email COLLATE NOCASE);
CREATE INDEX passes_serial ON passes (serial);
CREATE INDEX passes_template_list ON passes (template_id, id DESC);
