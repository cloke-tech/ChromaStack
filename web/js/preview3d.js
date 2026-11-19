import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';

export class Preview3D {
  constructor(el) {
    this.el = el;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    el.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.5, 5000);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(-120, -160, 260);
    this.scene.add(sun);
    this.group = new THREE.Group();
    this.scene.add(this.group);
    // Druckplatte als Bezug
    const bed = new THREE.Mesh(new THREE.PlaneGeometry(256, 256), new THREE.MeshStandardMaterial({ color: 0x2b2b2e, roughness: 0.9 }));
    bed.position.z = -0.01;
    this.bed = bed;
    this.scene.add(bed);
    const grid = new THREE.GridHelper(256, 16, 0x555555, 0x3a3a3a);
    grid.rotation.x = Math.PI / 2;
    this.scene.add(grid);
    this.parts = [];
    new ResizeObserver(() => this.resize()).observe(el);
    const loop = () => { this.controls.update(); this.renderer.render(this.scene, this.camera); this.raf = requestAnimationFrame(loop); };
    loop();
  }
  resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
  setMeshes(meshes, colors, size) {
    for (const p of this.parts) { p.geometry.dispose(); p.material.dispose(); this.group.remove(p); }
    this.parts = [];
    meshes.forEach((m, i) => {
      if (!m.indices.length) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
      g.setIndex(new THREE.BufferAttribute(m.indices, 1));
      g.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color(colors[i]), roughness: 0.75, flatShading: true });
      const mesh = new THREE.Mesh(g, mat);
      mesh.userData.order = i;
      this.group.add(mesh);
      this.parts.push(mesh);
    });
    this.setExplode(this.explode || 0);
    if (size && JSON.stringify(size) !== JSON.stringify(this.lastSize)) {
      this.lastSize = size;
      const r = Math.max(size[0], size[1]);
      this.camera.position.set(-r * 0.35, -r * 1.25, r * 1.0);
      this.controls.target.set(0, 0, 0);
    }
  }
  setExplode(v) {
    this.explode = v;
    for (const p of this.parts) p.position.z = v * p.userData.order * 1.2;
  }
}
