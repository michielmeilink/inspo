# inspo: context voor Claude

Persoonlijk dashboard waarmee Michiel (video-editor en animator) zijn opgeslagen Instagram-posts kan doorzoeken en bekijken.
Live op **https://inspo.michielmeilink.com**. Repo `michielmeilink/inspo` (publiek), branch `main`. Gebruiker-docs staan in `README.md`.

## Hosting
- GitHub Pages, deploy vanaf `main` / root. `CNAME` bevat `inspo.michielmeilink.com`. `.nojekyll` aanwezig.
- DNS bij TransIP: `inspo` CNAME `michielmeilink.github.io.` (de punt aan het eind is verplicht in TransIP).
- Geen build-stap, geen framework: `index.html`, `app.js`, `style.css`. JSZip 3.10.1 komt van cdnjs, het lettertype Archivo van Google Fonts.

## Data en beveiliging
- **`data.enc`**: de hele database, versleuteld met AES-256-GCM. De sleutel komt via PBKDF2-SHA256 (310k iteraties) uit Michiels wachtwoord. Formaat: `{v, kdf, iter, salt, iv, ct}`, base64.
  - **Nooit ontsleutelen of overschrijven.** Het wachtwoord typt hij zelf; Claude kent het niet. De dashboard-pagina commit regelmatig nieuwe versies ("Update inspiratie …", "Sync: N thumbnails").
- **`thumbs/<naam>.bin`**: JPEG-thumbnails (420 px breed), versleuteld met AES-GCM (12 bytes IV + ciphertext).
  - De sleutel is `db.tk` (32 willekeurige bytes in de database) via HKDF. Daardoor staan de thumbnails los van het wachtwoord, en hoeft er na een wachtwoordwissel niets opnieuw versleuteld te worden.
  - De bestandsnaam is een HMAC van de post-code (24 hex-tekens), zodat de repo niet verraadt welke posts het zijn.
  - Thumbnails worden geladen via `raw.githubusercontent.com` (CORS open, geen token nodig). Lukt dat niet, dan via de Contents API.
- **Opslaan**: GitHub Contents API (`PUT data.enc`) met een fine-grained token in `localStorage` (`insp.gh`). Het token heeft alleen Contents read & write op `inspo`.
  - Bij een conflict (409/422) wordt eerst samengevoegd met `mergeInto()` en daarna opnieuw geprobeerd.
  - De sync commit thumbnails en `data.enc` samen in één commit via de Git Data API (`ghCommitFiles`, batches van 40).
  - Alle schrijfacties naar GitHub lopen via `ghLocked()`, zodat ze nooit tegelijk lopen.
- `localStorage`-sleutels krijgen het voorvoegsel `insp.`: `gh`, `pw` (onthouden wachtwoord), `cache` (versleutelde blob), `ar` (beeldverhoudingen van embeds), `gone`, `view`, `sort`, `mode`, `cols`, `muted`.

## Datamodel (ontsleuteld)
```js
db = { v: 1, posts: { [code]: Post }, collections: [naam...], tk, syncedAt, updatedAt }
Post = { code, type: 'reel'|'p'|'tv', owner, caption, savedAt, takenAt, collections: [], tags: [], note,
         hidden, gone, thumb /* naam in thumbs/ */, w, h, dur, mt /* media_type, 8 = carousel */, n /* aantal slides */, addedAt, editedAt }
```
`editedAt` bepaalt bij het samenvoegen wiens tags, notitie of `hidden` wint. De rest wordt aangevuld of samengevoegd.

## app.js op hoofdlijnen
- Crypto (`encryptDb`/`decryptDb`), GitHub (`ghGet`/`ghPut`/`ghCommitFiles`), data (`addPost`, `mergeInto`).
- **Export-parser** (`parseExport`): leest `saved_posts.json` en `saved_collections.json` uit een Instagram-export (zip of losse json). Hij werkt robuust voor zowel het oude formaat (`string_map_data`) als het nieuwe (`label_values`, met Nederlandse labels zoals "Onderschrift" en "Gebruikersnaam").
  - `fixText` herstelt UTF-8-tekst die als latin-1 is opgeslagen ("Ã©" wordt "é").
- **Extensie-brug**: `extCall(cmd, args)` via `window.postMessage`. Het content script zet `data-inspo-ext` op `<html>` en meldt zich met `{__inspo:'ready'}`.
- **Sync** (`runSync`): eerst de saved-feed, dan elke collectie. Thumbnails worden **per pagina meteen** gemaakt en elke 40 gecommit (samen met `data.enc`). Onderbreken (herladen, stoppen) kost dus hooguit 40 thumbnails.
  - Een pagina telt als werk als er nieuwe posts, nieuwe collectie-koppelingen of ontbrekende thumbnails in staan. Een incrementele sync stopt bij de eerste pagina zonder werk, waardoor een onderbroken sync vanzelf verdergaat.
  - Posts die niet meer in de feed staan, worden daarna los opgevraagd via `media`, maximaal 120 per sync. Bij een 404 krijgen ze `gone`.
  - `db.syncStartedAt` wordt gezet bij de start en verwijderd als de sync klaar is. `maybeAutoSync` hervat een onderbroken sync, en start elke 6 uur na `syncedAt`.
  - Mislukken 6 thumbnail-downloads achter elkaar, dan stopt de sync met een duidelijke fout. Die blijft staan in `sync.lastError`: rood linksonder en in de instellingen.
  - Tussen verzoeken aan Instagram zit een pauze van 1,4 tot 3 seconden (`politePause`).
  - Les van 26 nov 2026: de eerste versie maakte pas thumbnails na de hele feed-walk. Een herlaad tussendoor leverde zo 0 thumbnails op, en dat zag je als witte en lege tegels.
- **Embed-fallback** (geen thumbnail): de officiële Instagram-embed in een iframe, bijgesneden met container-query-eenheden.
  - De embed stuurt een `MEASURE`-postMessage met zijn hoogte. Met kop 57 px en voet ongeveer 151 px volgt daaruit de beeldverhouding (`fitEmbed`).
  - Komt er binnen 7 seconden na het laden geen `MEASURE`, dan is de post verwijderd of afgeschermd ("niet meer beschikbaar").
  - De iframe wordt pas 1 seconde na `MEASURE` zichtbaar, om witte vlakken te voorkomen (het beeld in de embed laadt na de meting).
- **Weergaven**: wall (tegels in 9:16 met 2px naad, 3 tot 10 kolommen) en index (tekstlijst met een preview bij hover).
- **Speler** (`setupStage`/`mountPlayer`): met extensie een eigen `<video>` met een verse video-URL uit `media`-info. Er is een tijdlijn (scrubben, hover-tijd, resterende tijd), snelheid, geluid en carousel-bolletjes.
  - Sneltoetsen: k of spatie, j en l (±5 s), komma en punt (frame), m (geluid), ← → (vorige/volgende post), Esc. Carousels: ↑ ↓ vorige/volgende slide (zoals knippunten in Premiere/Resolve), 1–9 direct naar een slide, klikvlakken links/rechts op het beeld, vegen op touch, teller rechtsboven, buren worden voorgeladen. Op de wall krijgen carousels een markering met het aantal slides. De sneltoetstekst onder de notitie past zich aan (`setKeysHint`).
  - Zonder extensie, of als de video niet laadt: de embed.
- **Voortgang**: `progress(frac, label)` toont een dunne balk bovenin (−1 = onbepaald). Wordt gebruikt bij import (uitpakken, verwerken, opslaan) en sync.
- **Geschiedenis**: een collectie, tag of weergave doet `pushState` (`?c=…&t=…&m=index`), een geopende post voegt `#code` toe. De terugknop sluit de speler en gaat daarna naar de vorige collectie. `fromHistory` voorkomt dubbele stappen.

## Extensie (`extension/`, Chrome MV3, unpacked geladen)
- `bridge.js`: content script op `inspo.michielmeilink.com` en `localhost:8765`, relayt naar de background.
- `background.js` gebruikt de interne web-API van Instagram met het app-id van instagram.com (`X-IG-App-ID: 936619743392459`), in Michiels eigen sessie.
  - Eerst probeert hij `fetch` direct vanuit de extensie. Bij 401/403 of een antwoord dat geen JSON is, voert hij het verzoek uit in een instagram.com-tab via `chrome.scripting.executeScript({world:'MAIN'})`.
  - Commando's: `ping`, `media` (`/api/v1/media/{id}/info/`; het id volgt uit de shortcode via base64-decode), `savedPage` (`/api/v1/feed/saved/posts/`), `collections` (`/api/v1/collections/list/`), `collectionPage` (`/api/v1/feed/collection/{id}/posts/`) en `bytes` (CDN-afbeelding als base64, alleen `cdninstagram.com`/`fbcdn.net`; lukt dat direct niet, dan via de instagram.com-tab).
  - Foutcodes: `rate` (429), `login`, `gone`, `http`. Het dashboard toont die als melding.
- Na een wijziging aan de extensie moet Michiel in `chrome://extensions` op herladen klikken.
- Dit is niet getest tegen een echte Instagram-sessie vanuit Claude. Michiel heeft bevestigd dat de sync werkt (26 nov 2026). De interne API van Instagram kan veranderen.

## Design
- Een donkere montagekamer: puur zwart (`#000`), tekst `#f2f1ec`, gedimd `#7b7a75`. Geen accentkleur; selectie is wit tegen gedimd grijs.
- Eén lettertype, Archivo, waarbij de breedte-as (`wdth` 62–125) het verschil maakt. Het woordmerk `inspo` is `wdth 125` en `850`. Labels en interfacetekst in kleine letters.
- Referenties die Michiel zelf gaf: dannygevirtz.com (beeld edge-to-edge) en joannanguyen.com (kale tekstindex). Hij vond het resultaat goed. Houd deze richting aan.

## Werkwijze en valkuilen
- **Lokaal testen**: zet in `.claude/launch.json` van de sessie een python `http.server` op poort 8765 met `-d` naar deze map.
  - Gebruik een **testdatabase**: `state.blob = null; await unlock('testtest123', false)`. De lokale `data.enc` is Michiels echte data.
  - Importeer testdata via `importFiles([new File([json], 'saved_collections.json')])`.
  - Boots de extensie na met een `message`-listener die op `{__inspo:'req'}` antwoordt, en stub `ghCommitFiles`, `ghGet` en `ghPut`.
  - Ruim na afloop alle `insp.*`-sleutels in `localStorage` op.
- **Pushen**: eerst `git pull --rebase origin main`, want het dashboard commit zelf naar `main`. Wacht daarna tot Pages de nieuwe `app.js` serveert (ongeveer een minuut). Push alleen als Michiel daarom vraagt.
- Schrijf geen curl- of crawler-verzoeken naar instagram.com met een gespoofde user-agent. De auto-mode classifier blokkeert dat, terecht.
- Grote bewerkingen in `app.js` gaan het betrouwbaarst met een klein Python-patchscript (exacte string vervangen, met een check of de string bestaat). Heredocs met `rm` erin struikelen over een veiligheidscheck.
- Commits eindigen met `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Bekende beperkingen
- Een tegel zonder thumbnail is een embed. Bij een staande reel met een liggende video blijven daar soms zwarte balken in zitten, of een "Watch on Instagram"-label. Na een volledige sync heeft elke post een echte thumbnail.
- De embed-fallback heeft geen eigen tijdlijn. Video-URL's van Instagram verlopen; de speler haalt ze daarom elke keer vers op (met 20 minuten cache).
- GitHub Pages bouwt bij elke commit opnieuw (zachte limiet van ongeveer 10 builds per uur). Data en thumbnails komen via de API en raw, dus daar heeft dat geen last van.

## Volgende wensen (nog niet gebouwd)
Michiel wil later meer bronnen toevoegen. Zo is dat te doen:
- **YouTube** (begin hiermee): de Data API met OAuth geeft eigen playlists en likes. *Later bekijken* zit niet in de API, maar wel in Google Takeout (CSV). Thumbnails zijn openbaar (`i.ytimg.com`). De IFrame Player API is volledig bestuurbaar, dus de eigen tijdlijn kan werken.
- **Vimeo**: een API voor likes en *Watch later*, met een bestuurbare speler.
- **TikTok**: de data-export (JSON) bevat favoriete video's. Thumbnails via de openbare oEmbed. Afspelen alleen via de embed; de interne API is ondertekend en kwetsbaar.
- **Behance**: de openbare API geeft geen nieuwe sleutels meer uit, dus moodboards alleen via de extensie in een ingelogde tab. Vooral beelden, dus een galerijweergave.
- **Architectuur**: elke post krijgt een `source`-veld (`ig`, `yt`, `vm`, `tt`, `be`) en de sleutel wordt `source:id`, met een adapter per bron voor import, sync, thumbnail en speler. In de zijbalk komt een bronfilter. Tags, notities en de versleutelde thumbnails blijven gedeeld. Bestaande posts zonder `source` gelden als `ig`.
