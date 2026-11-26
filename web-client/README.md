# TouchDraw web app

TouchDraw web is an offline drawing app for iPhone and iPad. It also works in
modern desktop browsers. It is separate from the Android and Windows apps; it
does not provide PC control, networking, or project sync.

## Install on iPhone or iPad

1. Publish the contents of this folder at an **HTTPS** address with a valid
   certificate, using a static web server. The Windows host does not serve this
   app, and this project does not deploy it automatically.
2. Open that address in Safari on the device. Tap **Share > Add to Home Screen**
   and, if offered, enable **Open as Web App**.
3. Open TouchDraw from the Home Screen while still online. Wait for
   **Ready for offline use** before disconnecting. Repeat this step after an
   update. iOS/iPadOS 16.4 or newer is recommended.

Projects and color presets stay in the browser's storage on that device; they
are not automatically backed up or synced. Clearing website/app data, removing
the app, or storage eviction can delete them. The Safari tab and Home Screen
app may have separate storage. Use **Export > Prepare editable project JSON >
Share / download** to keep backups, and **Import JSON** to restore them or
open compatible Android/Windows projects. Files with freehand bucket fills use
project format version 3 and require updated TouchDraw apps.

## Drawing

Create a freehand sketch or a pixel-art project with 16, 32, or 64 pixel
frames and up to 16 frames. Draw with one finger or a stylus; use two fingers
to pan and pinch to zoom. **Fit** resets the view. Choose the brush, eraser,
bucket, eyedropper, size, and color from the horizontally scrolling toolbar.
The bucket fills connected pixels of exactly the tapped color; antialiased
freehand edges can retain a fringe. Eyedropper switches back to the brush.

Pixel projects support frame switching, onion skins, animation preview, and
selection. Drag a rectangle with **Select**, then drag inside it to move.
**Copy** and **Paste** use an app-local clipboard. Transparent pixels do not
cover the destination. Selection is unavailable in freehand projects.

Export PNG as a spritesheet in a chosen frame order, the current frame, or
individual frames. When sharing multiple files is unavailable, individual
frames download as a ZIP. On iOS, use the share sheet to save files or images.
For screen recording, use the device's **Control Center > Screen Recording**.

## Local development

Node.js is only needed for the model tests. From this folder:

```powershell
npm test
python -m http.server 8000 --bind 127.0.0.1
```

Open `http://localhost:8000` on the same computer. Localhost is suitable for
testing; a phone cannot use the computer's localhost address. HTTP over a LAN
is not sufficient for offline installation: use HTTPS on the actual device.
When changing cached files for a deployment, increment `CACHE` in
`service-worker.js` so existing installations receive the update.
