# ChromaStack

**Farbbilder aus Filament.** ChromaStack wandelt Bilder und PDFs in flache, mehrfarbige Schichtdrucke um:
eine weiße Basis und darüber dünne, verschachtelte Farbschichten – klassisch Cyan, Magenta, Gelb und Schwarz,
aber genauso jede andere Farbauswahl. Das fertige Projekt wird direkt im Slicer gebaut und auf Wunsch geslict.

*English below.*

## Funktionen
- Import von Bildern (PNG, JPG, WebP, SVG, …) und PDFs (Seitenauswahl), per Ziehen, Klick oder Einfügen
- Größen frei oder als Format (10×15, A6, A5, quadratisch …), Füllen/Einpassen/Strecken, Rand, Pixelgröße
- Bildanpassung (Helligkeit, Kontrast, Sättigung, Gamma), Rasterung und Glätten
- Vorschau: Vergleich Vorlage ↔ simulierter Druck, einzelne Schichten, 3D-Modell
- Beliebige Filamente und Sorten, Schwarz optional; „Was im Drucker ist übernehmen“ liest die Filamente aus dem Slicer
- „Beste Kombination finden“ wählt aus den verfügbaren Farben die Auswahl, die das Bild am besten trifft
- Alle Drucker aus Bambu Studio bzw. OrcaSlicer (Bambu Lab X1/P1/A1/H2D/X2D …, Creality, Prusa, …)
- Kalibrierkarte zum Abgleich der Lichtdurchlässigkeit (TD) der Filamente
- Sprachen: Deutsch, English, Français, Español, Italiano, Nederlands, Polski
- Desktop-App für macOS, Windows und Linux

## Installation
Installer gibt es unter *Releases* bzw. als Artefakte der GitHub-Actions-Builds:
- **macOS:** `.dmg` (Apple Silicon und Intel). Die App ist nicht notarisiert: beim ersten Start
  Rechtsklick → *Öffnen*, oder `xattr -dr com.apple.quarantine /Applications/ChromaStack.app`.
- **Windows:** `.exe`-Installer
- **Linux:** `.AppImage` oder `.deb`

Für fertige Projekte muss **Bambu Studio** oder **OrcaSlicer** installiert sein. Ohne Slicer
exportiert ChromaStack eine 3MF-Datei, die du selbst öffnest.

## Entwicklung
```bash
npm install
npm start            # Desktop-App
npm run serve        # nur Server + Browser (http://127.0.0.1:8790)
npm test             # Test ohne Oberfläche
npm run dist:mac     # Installer bauen (dist:win, dist:linux)
```
Übersetzungen stehen in `tools/i18n_table.py` (`npm run i18n` erzeugt `web/js/i18n-data.js`).

| Ordner | Inhalt |
|---|---|
| `web/` | Oberfläche, Farbmodell (`color.js`), Netzerzeugung (`mesh.js`), 3MF-Export |
| `backend/` | lokaler Server, Slicer-Erkennung, Profile, Projektbau über die Slicer-Kommandozeile |
| `electron/` | Desktop-App |
| `tools/` | Tests, Icon, Übersetzungstabelle |

---

## English
ChromaStack turns images and PDFs into flat multi-colour layer prints: a white base with thin,
interleaved colour layers (CMYK or any other set of filaments). It builds – and optionally slices – the
project with Bambu Studio or OrcaSlicer, for any printer those slicers know. Features include preview,
layer and 3D views, a calibration chart, importing the filaments loaded in your printer, an automatic
“best colour combination” search and seven UI languages. Installers for macOS, Windows and Linux are
built by GitHub Actions.
