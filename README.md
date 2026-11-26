# Inspiratie

Dashboard voor opgeslagen Instagram-posts, op `inspiratie.michielmeilink.com` (GitHub Pages).

- Tabs per collectie, zoeken op account, caption, tag en notitie
- Speler in een pop-up (Instagram-embed), met ← → naar de vorige of volgende post en Esc om te sluiten
- Eigen tags en notities per post
- Data staat versleuteld in `data.enc` (AES-256-GCM, sleutel via PBKDF2 uit je wachtwoord). Zonder wachtwoord is de repo onleesbaar.
- Opslaan gaat via de GitHub API met een token dat alleen in je browser staat

## Eenmalige setup

1. **Repo aanmaken.** Maak op GitHub een nieuwe repo `inspiratie` aan, publiek, zonder README. Push daarna deze map:
   ```bash
   git remote add origin https://github.com/michielmeilink/inspiratie.git
   git push -u origin main
   ```
2. **Pages aanzetten.** Ga naar repo → Settings → Pages → Source: *Deploy from a branch*, branch `main`, map `/ (root)`. Het custom domain wordt uit `CNAME` gehaald. Zet *Enforce HTTPS* aan zodra dat kan.
3. **DNS bij TransIP.** Voeg een record toe: `inspiratie` · `CNAME` · `michielmeilink.github.io.` (met de punt aan het eind, net als bij `recepten`).
4. **Token aanmaken.** Ga naar GitHub → Settings → Developer settings → Fine-grained tokens → *Generate new token*.
   - Repository access: *Only select repositories* → `inspiratie`
   - Permissions → Repository → **Contents: Read and write** (de rest blijft uit)
   - Kies zelf een vervaldatum. Daarna maak je een nieuw token en plak je dat opnieuw in.
5. **Koppelen.** Open de site → *GitHub-koppeling instellen* → plak het token → *Test koppeling* → *Opslaan*.
6. **Wachtwoord kiezen.** Kies een wachtwoord (minimaal 8 tekens). Dit is de sleutel van je data. **Ben je het kwijt, dan is de data niet meer te openen.** Download af en toe een back-up via Instellingen.

## Instagram-export importeren

Instagram → Instellingen → Accountcentrum → *Je informatie en machtigingen* → *Je informatie downloaden* →
*Sommige van je gegevens* → **Opgeslagen** → formaat **JSON** → bereik *Altijd*.

Je krijgt een zip. Sleep die (of `saved_posts.json` + `saved_collections.json`) op het dashboard. Als je opnieuw importeert, worden alleen nieuwe posts toegevoegd. Je tags en notities blijven staan.

## Op een ander apparaat

Open de site, vul bij *GitHub-koppeling instellen* hetzelfde token in en ontgrendel met je wachtwoord.
Zonder token kun je alleen kijken, niet opslaan: de site leest dan `data.enc` van Pages, dat een paar minuten achterloopt.

## Bekende beperkingen

- Thumbnails: Instagram geeft voor de meeste posts geen losse thumbnail-URL. Kaarten zonder afbeelding tonen het account als placeholder. De sync-extensie (volgende stap) vult thumbnails en captions aan.
- Een post die op Instagram verwijderd is, speelt niet meer af.

## Lokaal draaien

```bash
python3 -m http.server 8765
```
