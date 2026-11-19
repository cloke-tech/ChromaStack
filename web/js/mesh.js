// Baut für jedes Filament einen geschlossenen Körper aus Voxeln.
// Ebene 0 ist die durchgehende weiße Basis, Ebenen 1..N sind die Farbschichten.
// Welche Farbe in welcher Ebene liegt, steht in der Säulenfolge der Palette (pal.seq).

/**
 * @param {object} o
 *  W, H        Pixel
 *  pixel       Kantenlänge eines Pixels in mm
 *  idx         Uint16Array Kombinationsindex je Pixel
 *  seq         Uint8Array (n*N) Material je Farbschicht (0 = Weiß, c+1 = Farbe c)
 *  k           Anzahl Farbfilamente
 *  N           Farbschichten
 *  zBase       Dicke der Basis in mm
 *  h           Schichthöhe in mm
 * @returns {Array<{positions: Float32Array, indices: Uint32Array, tris: number}>} Index 0 = Weiß
 */
export function buildMeshes(o) {
  const { W, H, idx, seq, k, N } = o;
  const P = W * H;
  const L = N + 1;
  // Material je Ebene und Pixel
  const vox = new Uint8Array(L * P);
  for (let i = 0; i < P; i++) {
    const base = idx[i] * N;
    for (let l = 1; l <= N; l++) vox[l * P + i] = seq[base + l - 1];
  }
  const levelZ = new Float64Array(L + 1);
  levelZ[0] = 0;
  for (let l = 1; l <= L; l++) levelZ[l] = o.zBase + (l - 1) * o.h;
  const out = [];
  for (let m = 0; m <= k; m++) out.push(meshMaterial(W, H, L, o.pixel, levelZ, vox, m, o.offsetX ?? 0, o.offsetY ?? 0));
  return out;
}

function meshMaterial(W, H, L, p, levelZ, vox, m, offX, offY) {
  const P = W * H;
  const pos = [];
  const ind = [];
  const vmap = new Map();
  const W1 = W + 1, H1 = H + 1;
  const x0mm = -W * p / 2 + offX, y0mm = H * p / 2 + offY;
  // Gitterpunkt (gx, gy) auf Höhe zl (Grenze zwischen Ebene zl-1 und zl)
  const vert = (gx, gy, zl) => {
    const key = (zl * H1 + gy) * W1 + gx;
    let v = vmap.get(key);
    if (v === undefined) {
      v = pos.length / 3;
      pos.push(x0mm + gx * p, y0mm - gy * p, levelZ[zl]);
      vmap.set(key, v);
    }
    return v;
  };
  const quad = (a, b, c, d, nx, ny, nz) => {
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    const ux = pos[b * 3] - ax, uy = pos[b * 3 + 1] - ay, uz = pos[b * 3 + 2] - az;
    const vx = pos[c * 3] - ax, vy = pos[c * 3 + 1] - ay, vz = pos[c * 3 + 2] - az;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * nx + cy * ny + cz * nz >= 0) ind.push(a, b, c, a, c, d);
    else ind.push(a, d, c, a, c, b);
  };
  const occ = (l, i) => l >= 0 && l < L && vox[l * P + i] === m;

  // Waagrechte Flächen an jeder Ebenengrenze zl (0..L), gierig zu Rechtecken zusammengefasst
  const mask = new Int8Array(P); // +1 Fläche nach oben, -1 nach unten
  const seen = new Uint8Array(P);
  for (let zl = 0; zl <= L; zl++) {
    let any = false;
    for (let i = 0; i < P; i++) {
      const below = occ(zl - 1, i), above = occ(zl, i);
      mask[i] = below && !above ? 1 : above && !below ? -1 : 0;
      if (mask[i]) any = true;
    }
    if (!any) continue;
    seen.fill(0);
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      const i = r * W + c;
      const v = mask[i];
      if (!v || seen[i]) continue;
      let w = 1;
      while (c + w < W && !seen[i + w] && mask[i + w] === v) w++;
      let hh = 1;
      outer: while (r + hh < H) {
        const row = (r + hh) * W + c;
        for (let q = row; q < row + w; q++) if (seen[q] || mask[q] !== v) break outer;
        hh++;
      }
      for (let rr = r; rr < r + hh; rr++) seen.fill(1, rr * W + c, rr * W + c + w);
      quad(vert(c, r, zl), vert(c + w, r, zl), vert(c + w, r + hh, zl), vert(c, r + hh, zl), 0, 0, v);
    }
  }

  // Senkrechte Wände: je Kante die Ebenen, in denen nur eine Seite Material m hat,
  // senkrecht zu Intervallen und entlang der Kante zu Streifen zusammengefasst.
  const segs = [];
  const collect = (a, b, hasA, hasB) => {
    // Flächen von a, die zu b zeigen (dir 1), und von b, die zu a zeigen (dir 0)
    for (let dir = 1; dir >= 0; dir--) {
      let start = -1;
      for (let l = 0; l <= L; l++) {
        const on = l < L && (dir ? hasA && occ(l, a) && !(hasB && occ(l, b)) : hasB && occ(l, b) && !(hasA && occ(l, a)));
        if (on && start < 0) start = l;
        else if (!on && start >= 0) { segs.push((dir << 16) | (start << 8) | l); start = -1; }
      }
    }
  };
  const runs = new Map();
  const step = (pos, emit) => {
    const keep = new Set(segs);
    for (const key of segs) if (!runs.has(key)) runs.set(key, pos);
    for (const [key, start] of runs) if (!keep.has(key)) { emit(key, start, pos); runs.delete(key); }
  };
  for (let gx = 0; gx <= W; gx++) {
    const emit = (key, s, e) => {
      const dir = key >> 16, z0 = (key >> 8) & 255, z1 = key & 255;
      quad(vert(gx, s, z0), vert(gx, e, z0), vert(gx, e, z1), vert(gx, s, z1), dir ? 1 : -1, 0, 0);
    };
    for (let r = 0; r <= H; r++) {
      segs.length = 0;
      if (r < H) collect(r * W + gx - 1, r * W + gx, gx > 0, gx < W);
      step(r, emit);
    }
  }
  for (let gy = 0; gy <= H; gy++) {
    const emit = (key, s, e) => {
      const dir = key >> 16, z0 = (key >> 8) & 255, z1 = key & 255;
      quad(vert(s, gy, z0), vert(e, gy, z0), vert(e, gy, z1), vert(s, gy, z1), 0, dir ? -1 : 1, 0);
    };
    for (let c = 0; c <= W; c++) {
      segs.length = 0;
      if (c < W) collect((gy - 1) * W + c, gy * W + c, gy > 0, gy < H);
      step(c, emit);
    }
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(ind), tris: ind.length / 3 };
}

/** Volumen eines geschlossenen Netzes in mm³. */
export function meshVolume({ positions: P, indices: I }) {
  let v = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    v += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1])
       - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c])
       + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
  }
  return v / 6;
}
