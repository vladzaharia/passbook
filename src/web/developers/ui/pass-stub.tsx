/** A decorative QR-like grid for the static preview: a seeded pattern with three finders. Not a code. */
function grid(seed: string, n = 25): boolean[][] {
  let x = [...seed].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const rnd = () => {
    x = (x * 1103515245 + 12345) >>> 0;
    return ((x >>> 16) & 1) === 1;
  };
  const g = Array.from({ length: n }, () => Array.from({ length: n }, rnd));
  const finder = (r: number, c: number) => {
    for (let i = -1; i < 8; i++)
      for (let j = -1; j < 8; j++) {
        const y = r + i;
        const z = c + j;
        const row = g[y];
        if (!row || z < 0 || z >= n) continue;
        const ring = Math.max(Math.abs(i - 3), Math.abs(j - 3));
        row[z] = !(ring === 4 || ring === 2);
      }
  };
  finder(0, 0);
  finder(0, n - 7);
  finder(n - 7, 0);
  return g;
}

function Qr({ seed }: { seed: string }) {
  const n = 25;
  const rects: { x: number; y: number; w: number }[] = [];
  grid(seed, n).forEach((row, y) => {
    let x = 0;
    while (x < n) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      let e = x;
      while (e < n && row[e]) e += 1;
      rects.push({ x, y, w: e - x });
      x = e;
    }
  });
  return (
    <svg
      className="qr"
      viewBox={`-1 -1 ${n + 2} ${n + 2}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      {rects.map((r) => (
        <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width={r.w} height="1" />
      ))}
    </svg>
  );
}

/** The Harbor Club sandbox pass (Apple layout): a stand-in for PassCard until the playground ships. */
export function PassStub() {
  return (
    <div
      className="wpass"
      role="img"
      aria-label="Test preview of a Harbor Club membership pass, not installable"
    >
      <div className="testband">TEST PREVIEW · NOT INSTALLABLE</div>
      <div className="ph">
        <span className="logo">HC</span>
        <span className="lt">Harbor Club</span>
        <div className="hf">
          <div className="lab">Points</div>
          <div className="val">120</div>
        </div>
      </div>
      <div className="strip">
        <div className="big">
          <div className="lab">Member</div>
          <div className="val">Casey River</div>
        </div>
      </div>
      <div className="fields">
        <div>
          <div className="lab">Tier</div>
          <div className="val">Gold</div>
        </div>
        <div className="r">
          <div className="lab">Valid through</div>
          <div className="val">Jun 30, 2027</div>
        </div>
      </div>
      <div className="bc">
        <Qr seed="hbr1042" />
        <div className="bc-id">HBR-1042</div>
      </div>
    </div>
  );
}
