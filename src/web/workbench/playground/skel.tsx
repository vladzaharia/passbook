export function Skel({ ratio }: { ratio: string }) {
  return (
    <div
      className="pg-skel"
      style={{ aspectRatio: ratio }}
      role="status"
      aria-label="Loading preview"
    />
  );
}
