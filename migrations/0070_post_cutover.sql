-- One release after the cutover. Nothing reads or writes scanning_config_revisions: config_epoch replaced it.
DROP TABLE scanning_config_revisions;
