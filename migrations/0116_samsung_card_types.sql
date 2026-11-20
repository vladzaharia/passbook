-- Each provider instance records the Samsung card type its card was chosen by; NULL for Google
-- and for instances made before per-type cards (they use the default card).
ALTER TABLE wallet_provider_instances ADD COLUMN card_type TEXT;

CREATE TRIGGER wallet_provider_instances_card_type_immutable
BEFORE UPDATE OF card_type ON wallet_provider_instances
WHEN OLD.card_type IS NOT NULL AND OLD.card_type IS NOT NEW.card_type
BEGIN SELECT RAISE(ABORT, 'provider instance card type is immutable'); END;
