/** The key never renders: samples read it from the environment, shown as a chip. */
export function EnvChip({ name = '$PASSBOOK_KEY' }: { name?: string }) {
  return (
    <span className="envchip" title="Your test key, from .env">
      {name}
    </span>
  );
}
