# inspo

Dashboard voor opgeslagen Instagram-posts, op `inspo.michielmeilink.com` (GitHub Pages).

- Twee weergaven: *wall* (een naadloze wand van echte frames) en *index* (een tekstlijst met preview bij hover)
- Collecties en tags in de zijbalk, zoeken op account, caption, tag en notitie (toets `/`)
- Afspelen schermvullend op zwart, met ← → naar de vorige of volgende post en Esc om te sluiten
- Eigen tags en notities per post
- Data staat versleuteld in `data.enc` (AES-256-GCM, sleutel via PBKDF2 uit je wachtwoord). Zonder wachtwoord is de repo onleesbaar.
- Opslaan gaat via de GitHub API met een token dat alleen in je browser staat

## Eenmalige setup

1. **Repo aanmaken.** Maak op GitHub een nieuwe repo `inspo` aan, publiek, zonder README. Push daarna deze map:
   ```bash
   git remote add origin https://github.com/michielmeilink/inspo.git
   git push -u origin main
   ```
2. **Pages aanzetten.** Ga naar repo → Settings → Pages → Source: *Deploy from a branch*, branch `main`, map `/ (root)`. Het custom domain wordt uit `CNAME` gehaald. Zet *Enforce HTTPS* aan zodra dat kan.
3. **DNS bij TransIP.** Voeg een record toe: `inspo` · `CNAME` · `michielmeilink.github.io.` (met de punt aan het eind, net als bij `recepten`).
4. **Token aanmaken.** Ga naar GitHub → Settings → Developer settings → Fine-grained tokens → *Generate new token*.
   - Repository access: *Only select repositories* → `inspo`
   - Permissions → Repository → **Contents: Read and write** (de rest blijft uit)
   - Kies zelf een vervaldatum. Daarna maak je een nieuw token en plak je dat opnieuw in.
5. **Koppelen.** Open de site → *GitHub-koppeling instellen* → plak het token → *Test koppeling* → *Opslaan*.
6. **Wachtwoord kiezen.** Kies een wachtwoord (minimaal 8 tekens). Dit is de sleutel van je data. **Ben je het kwijt, dan is de data niet meer te openen.** Download af en toe een back-up via Instellingen.

## Instagram-export importeren

Instagram → Instellingen → Accountcentrum → *Je informatie en machtigingen* → *Je informatie downloaden* →
*Sommige van je gegevens* → **Opgeslagen** → formaat **JSON** → bereik *Altijd*.

Je krijgt een zip. Sleep die (of `saved_posts.json` + `saved_collections.json`) op het dashboard. Als je opnieuw importeert, worden alleen nieuwe posts toegevoegd. Je tags en notities blijven staan.

## Sync-extensie (Chrome)

De extensie in de map `extension/` doet drie dingen, in je eigen ingelogde browser:
- je opgeslagen posts en collecties ophalen, zodat nieuwe saves zonder export binnenkomen;
- echte thumbnails maken. Die gaan versleuteld naar `thumbs/` in de repo en zijn daarna op elk apparaat zichtbaar;
- video's hier afspelen in een eigen speler met tijdlijn, in plaats van de Instagram-embed.

**Installeren**
1. Open `chrome://extensions`.
2. Zet *Ontwikkelaarsmodus* aan (rechtsboven).
3. Klik op *Uitgepakte extensie laden* en kies de map `extension` uit deze repo.
4. Zorg dat je op instagram.com bent ingelogd in dezelfde Chrome.
5. Open het dashboard en klik linksonder op **sync instagram**. De eerste sync duurt een tijdje (alle pagina's en ruim 1000 thumbnails). Daarna synct het dashboard automatisch als de vorige sync meer dan 6 uur geleden is.

De extensie wacht 1,5 tot 3 seconden tussen verzoeken aan Instagram. Krijg je een melding dat Instagram om pauze vraagt, wacht dan een uur.

**Sneltoetsen in de speler:** spatie of `k` afspelen of pauzeren, `j` en `l` 5 seconden terug of vooruit, `,` en `.` één frame terug of vooruit, `m` geluid. Met ← → ga je naar de vorige of volgende post.

**Carousels:** ↑ ↓ naar de vorige of volgende slide (zoals knippunten in Premiere en Resolve), `1` t/m `9` direct naar die slide. Je kunt ook links of rechts op het beeld klikken, of vegen op je telefoon.

## Op een ander apparaat

Open de site, vul bij *GitHub-koppeling instellen* hetzelfde token in en ontgrendel met je wachtwoord.
Zonder token kun je alleen kijken, niet opslaan: de site leest dan `data.enc` van Pages, dat een paar minuten achterloopt.

## Bekende beperkingen

- Zonder sync zijn de beelden de officiële Instagram-embeds, bijgesneden tot alleen het frame. De embed meldt zijn hoogte, en daaruit volgt de uitsnede. Bij staande reels met een liggende video kunnen zwarte balken zichtbaar blijven.
- Een embed die nooit zijn hoogte meldt, is een verwijderde of afgeschermde post. Die wordt getoond als "niet meer beschikbaar".
- Een post die op Instagram verwijderd is, speelt niet meer af.

## Lokaal draaien

```bash
python3 -m http.server 8765
```
