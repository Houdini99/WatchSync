import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { navigate } from '../lib/nav';

// ═══════════════════════════════════════════════════════════════════════════
//
//  FILL THIS IN BEFORE DEPLOYING. The values below are placeholders — whoever
//  runs an instance is its controller and must enter their own details (see
//  "Privacy policy" in the README).
//
//  Art. 13(1)(a)+(b) GDPR requires the controller's identity and contact
//  details. For a private, non-commercial service there is no § 5 DDG
//  ("Impressum") duty, so a postal address is not required — a real name plus a
//  working contact address is enough. `address` may stay empty; the block is
//  simply omitted then. `authority` should be the data-protection authority of
//  the federal state you live in (Art. 77 GDPR); leaving it empty falls back to
//  the generic pointer to the list of German authorities.
// ═══════════════════════════════════════════════════════════════════════════
const CONTROLLER = {
  name: '[Your full name]',
  address: [] as string[], // e.g. ['Musterstraße 1', '12345 Musterstadt', 'Deutschland']
  email: 'privacy@example.com',
  /** Who runs the machine this instance is hosted on (Art. 28 processor).
   *  Naming them is optional — Art. 13(1)(e) is satisfied by the category
   *  alone — so '' renders the unnamed wording. */
  hoster: '',
  /** Your competent supervisory authority, or '' for the generic pointer. */
  authority: '',
};

const LAST_UPDATED = { de: '2. September 2026', en: '2 September 2026' };

const AUTHORITY_LIST = 'https://www.bfdi.bund.de/DE/Service/Anschriften/anschriften_node.html';
const GOOGLE_PRIVACY = 'https://policies.google.com/privacy';

type Lang = 'de' | 'en';
const LANG_KEY = 'ws_legal_lang';

// ── Layout primitives ──────────────────────────────────────────────────────

function H({ children }: { children: ReactNode }) {
  return <h2 className="mb-3 mt-10 border-b border-border pb-2 text-lg font-semibold tracking-tight">{children}</h2>;
}

function P({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <p className={`mb-3 leading-relaxed text-dim ${className}`}>{children}</p>;
}

/** Sub-heading inside a numbered section (7.1, 7.2 …). */
function SubH({ children }: { children: ReactNode }) {
  return <h3 className="mb-2 mt-6 font-medium tracking-tight">{children}</h3>;
}

function UL({ children }: { children: ReactNode }) {
  return <ul className="mb-3 list-disc space-y-1.5 pl-5 leading-relaxed text-dim marker:text-border">{children}</ul>;
}

/** Two- or three-column reference table; scrolls on narrow screens. */
function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="mb-4 overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
        <thead>
          <tr className="bg-surface2">
            {head.map((h) => (
              <th key={h} className="px-3 py-2 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-t border-border align-top">
              {row.map((cell, j) => (
                <td key={j} className={`px-3 py-2 text-dim ${j === 0 ? 'whitespace-nowrap font-mono text-xs' : ''}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function A({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="text-accent underline-offset-2 hover:underline">
      {children}
    </a>
  );
}

function Controller() {
  return (
    <address className="mb-3 not-italic leading-relaxed text-dim">
      {CONTROLLER.name}
      {CONTROLLER.address.map((line) => (
        <span key={line} className="block">
          {line}
        </span>
      ))}
      <a href={`mailto:${CONTROLLER.email}`} className="text-accent underline-offset-2 hover:underline">
        {CONTROLLER.email}
      </a>
    </address>
  );
}

// ── German (primary) ───────────────────────────────────────────────────────

function German() {
  return (
    <>
      <P>
        WatchSync ist ein <strong className="text-text">privat betriebenes, nicht-kommerzielles Hobbyprojekt</strong>.
        Es wird kein Geld verdient, es gibt keine Werbung, kein Tracking, keine Analyse-Werkzeuge und keinen Verkauf
        oder Austausch von Daten. Diese Erklärung informiert nach Art. 13 DSGVO darüber, welche personenbezogenen Daten
        beim Betrieb anfallen, warum, auf welcher Rechtsgrundlage und wie lange.
      </P>

      <H>1. Verantwortlicher</H>
      <P>Verantwortlich für die Datenverarbeitung auf dieser Seite im Sinne von Art. 4 Nr. 7 DSGVO ist:</P>
      <Controller />
      <P>
        Ein Datenschutzbeauftragter ist nicht benannt; die Voraussetzungen des Art. 37 DSGVO bzw. § 38 BDSG liegen für
        ein privates Angebot dieser Größe nicht vor.
      </P>

      <H>2. Das Wichtigste in Kürze</H>
      <UL>
        <li>Kein Tracking, keine Cookies zu Werbe- oder Analysezwecken, keine Profilbildung.</li>
        <li>
          Räume, Chatverlauf, Warteschlange und Teilnehmerliste liegen ausschließlich im Arbeitsspeicher des Servers und
          werden <strong className="text-text">fünf Minuten</strong> nach dem Verlassen des letzten Teilnehmers
          vollständig gelöscht. Nichts davon wird auf eine Festplatte geschrieben.
        </li>
        <li>Ein Konto ist optional und benötigt keine E-Mail-Adresse.</li>
        <li>
          Die einzige Verbindung zu einem Drittanbieter ist YouTube (Google) — und auch die erst, wenn tatsächlich ein
          YouTube-Video abgespielt wird, siehe Abschnitt 7. Alle anderen Videoquellen werden über den Server geholt,
          deine IP-Adresse erreicht diese Quellen also nicht.
        </li>
      </UL>

      <H>3. Aufruf der Seite: Server-Logdaten</H>
      <P>
        Beim Abruf jeder Seite und jeder Datei übermittelt dein Browser technisch notwendige Daten, die der Webserver
        in einer Protokolldatei festhält:
      </P>
      <UL>
        <li>IP-Adresse</li>
        <li>Datum und Uhrzeit des Zugriffs</li>
        <li>angeforderte Adresse (URL) und HTTP-Statuscode</li>
        <li>übertragene Datenmenge</li>
        <li>Referrer (die zuvor besuchte Seite, sofern der Browser sie sendet)</li>
        <li>Browser- und Betriebssystemkennung (User-Agent)</li>
      </UL>
      <P>
        <strong className="text-text">Zweck:</strong> Auslieferung der Seite, Betriebssicherheit und Fehlersuche.{' '}
        <strong className="text-text">Rechtsgrundlage:</strong> Art. 6 Abs. 1 lit. f DSGVO — berechtigtes Interesse am
        technisch fehlerfreien und missbrauchssicheren Betrieb. Diese Protokolle werden nicht ausgewertet, nicht mit
        anderen Daten zusammengeführt und nicht an Dritte weitergegeben; sie werden ausschließlich im Störungsfall
        eingesehen. Sie verbleiben lokal auf dem Server und werden spätestens gelöscht, wenn der Dienst aktualisiert
        oder neu aufgesetzt wird.
      </P>
      <P>
        Zusätzlich wird die IP-Adresse <strong className="text-text">flüchtig im Arbeitsspeicher</strong> als Schlüssel
        für eine Missbrauchsbremse (Rate-Limit) beim Anlegen von Räumen und beim Anmelden verwendet. Diese Einträge
        verfallen nach spätestens zehn Minuten Inaktivität und werden nirgends gespeichert.
      </P>

      <H>4. Nutzung eines Raums</H>
      <P>
        Ein Raum entsteht per Klick, ohne Anmeldung. Was du dort eingibst, wird an alle anderen Teilnehmer desselben
        Raums verteilt — das ist der Zweck der Anwendung. Verarbeitet werden:
      </P>
      <Table
        head={['Daten', 'Zweck', 'Speicherung']}
        rows={[
          ['Nickname', 'Anzeige in Teilnehmerliste und Chat. Frei wählbar, ein Klarname ist nicht erforderlich.', 'nur Arbeitsspeicher'],
          ['Chatnachrichten', 'Unterhaltung im Raum; die letzten 80 Nachrichten werden für später Hinzukommende vorgehalten.', 'nur Arbeitsspeicher'],
          ['Reaktionen (Emoji)', 'Kurze Einblendung über dem Video.', 'nicht gespeichert'],
          ['Video-URLs / Warteschlange', 'Gemeinsame Wiedergabe.', 'nur Arbeitsspeicher'],
          ['Wiedergabestatus, Position, Tempo', 'Synchronisation zwischen den Teilnehmern.', 'nur Arbeitsspeicher'],
          ['Zufalls-ID des Browsers, Sitz- und Host-Token', 'Wiedererkennen deines Platzes nach einem Verbindungsabbruch; Schutz davor, dass Fremde deinen Platz oder Host-Status übernehmen.', 'Arbeitsspeicher + dein Browser'],
        ]}
      />
      <P>
        <strong className="text-text">Rechtsgrundlage:</strong> Art. 6 Abs. 1 lit. b DSGVO — Erfüllung der von dir
        selbst angeforderten Funktion; hinsichtlich der Sitzungs-Token ergänzend Art. 6 Abs. 1 lit. f DSGVO
        (Sicherheit). Die Angabe eines Nicknames ist weder gesetzlich noch vertraglich vorgeschrieben; ohne ihn kannst
        du einem Raum allerdings nicht beitreten.
      </P>
      <P>
        <strong className="text-text">Empfänger:</strong> die übrigen Teilnehmer desselben Raums. Wer einen Raumlink
        besitzt, kann den Raum betreten. Teile Raumlinks daher nur mit Personen, denen du vertraust, und behandle den
        Chat nicht als vertraulichen Kanal.
      </P>

      <H>5. Speicherung auf deinem Gerät</H>
      <P>
        Die Anwendung setzt keine Werbe- oder Analyse-Cookies. Im lokalen Speicher (<code>localStorage</code>) deines
        Browsers werden ausschließlich für den Betrieb erforderliche Werte abgelegt; sie verlassen dein Gerät nur, wenn
        sie für die genannte Funktion an den Server gesendet werden müssen:
      </P>
      <Table
        head={['Schlüssel', 'Inhalt und Zweck']}
        rows={[
          ['ws_client_id', 'Zufällige Kennung dieses Browsers, damit du nach einem Verbindungsabbruch deinen Platz zurückbekommst. Kein Bezug zu deiner Person, keine geräteübergreifende Wiedererkennung.'],
          ['ws_seat_<raum>', 'Geheimes Token für deinen Platz in einem Raum.'],
          ['ws_host_<raum>', 'Token, das deinen Host-Status in einem Raum bestätigt.'],
          ['ws_nickname', 'Zuletzt verwendeter Nickname, damit du ihn nicht erneut eintippen musst.'],
          ['ws_theme, ws_sound', 'Deine Einstellungen für hell/dunkel und Benachrichtigungston.'],
          ['ws_caption_lang', 'Zuletzt gewählte Untertitelsprache.'],
          ['ws_legal_lang', 'Sprache, in der du diese Seite zuletzt gelesen hast.'],
        ]}
      />
      <P>
        <strong className="text-text">Rechtsgrundlage:</strong> § 25 Abs. 2 Nr. 2 TDDDG — die Speicherung ist
        unbedingt erforderlich, um den von dir ausdrücklich gewünschten Dienst bereitzustellen; eine Einwilligung ist
        dafür nicht erforderlich. Für die anschließende Verarbeitung: Art. 6 Abs. 1 lit. b und f DSGVO. Du kannst diese
        Werte jederzeit über die Einstellungen deines Browsers löschen („Website-Daten löschen"); danach giltst du als
        neuer Besucher und verlierst Sitz- und Host-Token laufender Räume.
      </P>

      <H>6. Optionales Benutzerkonto</H>
      <P>
        Ein Konto brauchst du nur, wenn du dir einen dauerhaften Raumnamen (z. B. <code>/r/filmabend</code>) sichern
        willst. Es wird <strong className="text-text">keine E-Mail-Adresse</strong> und keine sonstige
        Kontaktinformation abgefragt. Gespeichert werden in einer Datenbank auf dem Server:
      </P>
      <UL>
        <li>Benutzername und Anzeigename (frei wählbar)</li>
        <li>Passwort — ausschließlich als Argon2id-Hash, das Passwort selbst wird nie gespeichert</li>
        <li>Zeitpunkt der Registrierung</li>
        <li>die von dir reservierten Raumnamen samt Zeitpunkt der Reservierung</li>
        <li>
          aktive Sitzungen: ein Hash des Sitzungstokens, Erstellungs-, Ablauf- und letzter Nutzungszeitpunkt (keine
          IP-Adresse, kein Gerätename)
        </li>
      </UL>
      <P>
        Die Anmeldung setzt ein technisch notwendiges Cookie <code>ws_session</code> (HttpOnly, SameSite=Lax,
        Laufzeit 30 Tage, verlängert sich bei Nutzung). Es enthält ausschließlich ein Zufallstoken und dient allein
        dazu, dich angemeldet zu halten. Beim Abmelden wird es gelöscht und die Sitzung serverseitig entfernt;
        abgelaufene Sitzungen werden automatisch gelöscht.
      </P>
      <P>
        <strong className="text-text">Rechtsgrundlage:</strong> Art. 6 Abs. 1 lit. b DSGVO (Bereitstellung des von dir
        angeforderten Kontos), für das Sitzungscookie zusätzlich § 25 Abs. 2 Nr. 2 TDDDG.
      </P>

      <H>7. Videoquellen und Drittanbieter</H>
      <SubH>7.1 YouTube</SubH>
      <P>
        Für die Wiedergabe von YouTube-Videos wird der offizielle YouTube-Player eingebunden. Dazu lädt dein Browser
        Programmcode direkt von <code>www.youtube.com</code>, der Player läuft in einem eingebetteten Fenster von
        YouTube, Vorschaubilder kommen von <code>i.ytimg.com</code> und Untertitel werden direkt bei YouTube abgerufen.
        Dabei erhält Google zwangsläufig deine IP-Adresse, Angaben zu Browser und Gerät sowie die Information, dass von
        dieser Seite aus auf YouTube zugegriffen wurde; Google kann dabei eigene Cookies setzen oder auslesen und die
        Nutzung mit deinem Google-Konto verknüpfen, falls du angemeldet bist.
      </P>
      <P>
        <strong className="text-text">Wichtig:</strong> Diese Verbindung entsteht erst in dem Moment, in dem
        tatsächlich ein YouTube-Video abgespielt wird. Beim bloßen Aufruf der Startseite oder eines Raums wird nichts
        von Google geladen — Google erfährt von deinem Besuch dann gar nichts.
      </P>
      <P>
        Anbieter ist Google Ireland Limited, Gordon House, Barrow Street, Dublin 4, Irland, für Nutzer im EWR;
        eine Übermittlung in die USA an Google LLC findet statt. Google LLC ist unter dem EU-US Data Privacy Framework
        zertifiziert, sodass ein Angemessenheitsbeschluss der EU-Kommission nach Art. 45 DSGVO als Grundlage der
        Übermittlung dient. Welche Daten Google verarbeitet, ist der{' '}
        <A href={GOOGLE_PRIVACY}>Datenschutzerklärung von Google</A> zu entnehmen. Auf diese Verarbeitung besteht
        seitens des Betreibers dieser Seite kein Einfluss.
      </P>
      <P>
        <strong className="text-text">Rechtsgrundlage:</strong> Art. 6 Abs. 1 lit. b DSGVO — die Einbindung ist
        erforderlich, um die von dir selbst angeforderte Funktion (dieses YouTube-Video gemeinsam ansehen) zu
        erbringen; ergänzend Art. 6 Abs. 1 lit. f DSGVO und § 25 Abs. 2 Nr. 2 TDDDG für den dafür technisch
        erforderlichen Zugriff auf dein Endgerät. Wenn du auch das vermeiden willst, spiele keine YouTube-Links ab
        und blockiere <code>youtube.com</code> im Browser, etwa mit einem Inhaltsblocker.
      </P>

      <SubH>7.2 Alle anderen Quellen</SubH>
      <P>
        Direkte Videodateien, HLS-Streams und Links zu anderen Portalen werden <em>vom Server</em> geholt, dort
        aufbereitet und dir von dieser Seite ausgeliefert. Die ursprüngliche Quelle sieht daher nur die IP-Adresse des
        Servers, nicht deine. Auch Videotitel werden serverseitig abgefragt. Es findet kein Einbetten fremder Skripte,
        Schriften oder Zählpixel statt.
      </P>

      <H>8. Empfänger der Daten</H>
      <UL>
        <li>die übrigen Teilnehmer eines Raums (Nickname, Chat, Reaktionen, ausgewählte Videos)</li>
        <li>Google (nur im Umfang von Abschnitt 7.1)</li>
        <li>
          der Anbieter des Servers, auf dem dieser Dienst läuft, als Auftragsverarbeiter nach Art. 28 DSGVO
          {CONTROLLER.hoster ? `: ${CONTROLLER.hoster}` : ''}
        </li>
      </UL>
      <P>
        Darüber hinaus werden keine Daten weitergegeben. Eine Weitergabe an Behörden erfolgt nur, soweit dazu eine
        gesetzliche Verpflichtung besteht.
      </P>

      <H>9. Speicherdauer im Überblick</H>
      <Table
        head={['Daten', 'Dauer']}
        rows={[
          ['Raum, Chat, Warteschlange, Teilnehmer', 'gelöscht 5 Minuten nachdem der letzte Teilnehmer den Raum verlassen hat'],
          ['Chatverlauf innerhalb eines Raums', 'nur die letzten 80 Nachrichten'],
          ['Server-Logdaten', 'nur lokal auf dem Server, keine Auswertung; gelöscht spätestens beim Aktualisieren oder Neuaufsetzen des Dienstes'],
          ['IP im Rate-Limit', 'höchstens 10 Minuten nach dem letzten Zugriff'],
          ['Kontodaten', 'bis zur Löschung des Kontos auf deine Anfrage hin'],
          ['Sitzungen', '30 Tage ab letzter Nutzung; sofort beim Abmelden'],
          ['Reservierte Raumnamen', 'bis du sie freigibst oder das Konto gelöscht wird'],
          ['Daten in deinem Browser', 'bis du die Website-Daten löschst'],
        ]}
      />

      <H>10. Keine automatisierte Entscheidungsfindung</H>
      <P>
        Es findet keine automatisierte Entscheidungsfindung einschließlich Profiling im Sinne von Art. 22 DSGVO statt.
        Es werden keine Daten für Werbung, Marktforschung oder Reichweitenmessung verarbeitet.
      </P>

      <H>11. Deine Rechte</H>
      <P>Dir stehen gegenüber dem Verantwortlichen folgende Rechte zu:</P>
      <UL>
        <li>
          <strong className="text-text">Auskunft</strong> über die zu deiner Person gespeicherten Daten (Art. 15 DSGVO)
        </li>
        <li>
          <strong className="text-text">Berichtigung</strong> unrichtiger Daten (Art. 16 DSGVO)
        </li>
        <li>
          <strong className="text-text">Löschung</strong> (Art. 17 DSGVO) — ein Konto wird auf formlose Anfrage
          vollständig gelöscht
        </li>
        <li>
          <strong className="text-text">Einschränkung der Verarbeitung</strong> (Art. 18 DSGVO)
        </li>
        <li>
          <strong className="text-text">Datenübertragbarkeit</strong> (Art. 20 DSGVO)
        </li>
        <li>
          <strong className="text-text">Widerspruch</strong> gegen Verarbeitungen, die auf Art. 6 Abs. 1 lit. f DSGVO
          gestützt sind (Art. 21 DSGVO)
        </li>
        <li>
          <strong className="text-text">Widerruf</strong> einer erteilten Einwilligung mit Wirkung für die Zukunft
          (Art. 7 Abs. 3 DSGVO)
        </li>
      </UL>
      <P>
        Zur Ausübung genügt eine formlose Nachricht an{' '}
        <a href={`mailto:${CONTROLLER.email}`} className="text-accent underline-offset-2 hover:underline">
          {CONTROLLER.email}
        </a>
        . Da Räume und Chats nur im Arbeitsspeicher existieren und automatisch verfallen, gibt es zu reiner
        Gastnutzung in aller Regel keine gespeicherten Daten mehr, über die Auskunft erteilt werden könnte.
      </P>
      <P>
        Unabhängig davon steht dir ein <strong className="text-text">Beschwerderecht bei einer
        Datenschutz-Aufsichtsbehörde</strong> zu (Art. 77 DSGVO), insbesondere in dem EU-Mitgliedstaat deines
        Aufenthaltsorts, deines Arbeitsplatzes oder des Orts des mutmaßlichen Verstoßes.{' '}
        {CONTROLLER.authority ? (
          <>Zuständig für den Verantwortlichen ist: {CONTROLLER.authority}.</>
        ) : (
          <>
            Eine Liste der deutschen Aufsichtsbehörden findest du{' '}
            <A href={AUTHORITY_LIST}>beim BfDI</A>.
          </>
        )}
      </P>

      <H>12. Datensicherheit</H>
      <P>
        Die Verbindung ist per HTTPS/TLS verschlüsselt. Passwörter werden ausschließlich als Argon2id-Hash abgelegt,
        Sitzungstokens nur als Hash. Das Sitzungscookie ist HttpOnly und SameSite=Lax gesetzt, ergänzt um eine strikte
        Content-Security-Policy und weitere Sicherheitsheader. Eine vollständige Sicherheit der Datenübertragung im
        Internet kann dennoch niemand garantieren.
      </P>

      <H>13. Minderjährige</H>
      <P>
        Das Angebot richtet sich nicht gezielt an Kinder. Personen unter 16 Jahren sollten es nur mit Zustimmung der
        Erziehungsberechtigten nutzen.
      </P>

      <H>14. Änderungen dieser Erklärung</H>
      <P>
        Diese Erklärung wird angepasst, wenn sich die Anwendung ändert. Es gilt jeweils die hier veröffentlichte
        Fassung. Stand: {LAST_UPDATED.de}.
      </P>
      <P className="text-xs">
        Hinweis: WatchSync wird rein privat und nicht geschäftsmäßig betrieben. Eine Anbieterkennzeichnung
        („Impressum") nach § 5 DDG ist daher nicht erforderlich; die Pflichten der DSGVO gelten unabhängig davon und
        werden mit dieser Erklärung erfüllt.
      </P>
    </>
  );
}

// ── English ────────────────────────────────────────────────────────────────

function English() {
  return (
    <>
      <P>
        WatchSync is a <strong className="text-text">privately run, non-commercial hobby project</strong>. It makes no
        money, carries no advertising, uses no tracking or analytics tools, and never sells or trades data. This notice
        explains, as required by Art. 13 GDPR, what personal data the service processes, why, on what legal basis, and
        for how long. The German version is the authoritative one.
      </P>

      <H>1. Controller</H>
      <P>The controller for the processing described here, within the meaning of Art. 4(7) GDPR, is:</P>
      <Controller />
      <P>
        No data protection officer has been appointed: a private service of this size does not meet the thresholds of
        Art. 37 GDPR or § 38 BDSG.
      </P>

      <H>2. In short</H>
      <UL>
        <li>No tracking, no advertising or analytics cookies, no profiling.</li>
        <li>
          Rooms, chat history, the queue and the participant list live only in the server's memory and are{' '}
          <strong className="text-text">deleted five minutes</strong> after the last person leaves. None of it is
          written to disk.
        </li>
        <li>Accounts are optional and require no email address.</li>
        <li>
          The only third party your browser talks to is YouTube (Google) — and only once a YouTube video is actually
          played, see section 7. Every other video source is fetched by the server, so your IP address never reaches
          it.
        </li>
      </UL>

      <H>3. Visiting the site: server logs</H>
      <P>Every page and file request sends technically necessary data that the web server records in a log file:</P>
      <UL>
        <li>IP address</li>
        <li>date and time of the request</li>
        <li>requested URL and HTTP status code</li>
        <li>amount of data transferred</li>
        <li>referrer (the previous page, if your browser sends it)</li>
        <li>browser and operating system identifier (user agent)</li>
      </UL>
      <P>
        <strong className="text-text">Purpose:</strong> delivering the site, operational security and troubleshooting.{' '}
        <strong className="text-text">Legal basis:</strong> Art. 6(1)(f) GDPR — legitimate interest in running the
        service reliably and protecting it from abuse. These logs are not analysed, not combined with other data and
        not shared; they are read only when something breaks. They stay local to the server and are deleted at the
        latest when the service is updated or rebuilt.
      </P>
      <P>
        Your IP address is additionally held <strong className="text-text">transiently in memory</strong> as the key
        for an abuse throttle on room creation and sign-in. Those entries expire after at most ten minutes of
        inactivity and are never stored.
      </P>

      <H>4. Using a room</H>
      <P>
        A room is created with one click, without an account. What you type there is distributed to everyone else in
        the same room — that is the point of the app. Processed data:
      </P>
      <Table
        head={['Data', 'Purpose', 'Storage']}
        rows={[
          ['Nickname', 'Shown in the participant list and chat. Freely chosen; a real name is not required.', 'memory only'],
          ['Chat messages', 'Conversation in the room; the last 80 messages are kept for late joiners.', 'memory only'],
          ['Reactions (emoji)', 'Brief overlay on the video.', 'not stored'],
          ['Video URLs / queue', 'Shared playback.', 'memory only'],
          ['Playback state, position, speed', 'Keeping participants in sync.', 'memory only'],
          ['Random browser ID, seat and host tokens', 'Reclaiming your seat after a dropped connection, and preventing anyone else from taking your seat or host status.', 'memory + your browser'],
        ]}
      />
      <P>
        <strong className="text-text">Legal basis:</strong> Art. 6(1)(b) GDPR — providing the function you asked for;
        for the tokens additionally Art. 6(1)(f) GDPR (security). Providing a nickname is neither a statutory nor a
        contractual requirement, but without one you cannot join a room.
      </P>
      <P>
        <strong className="text-text">Recipients:</strong> the other people in the same room. Anyone holding a room
        link can enter it. Share room links only with people you trust, and do not treat the chat as a confidential
        channel.
      </P>

      <H>5. Data stored on your device</H>
      <P>
        The app sets no advertising or analytics cookies. Only values required to operate the service are kept in your
        browser's <code>localStorage</code>; they leave your device only when the corresponding function has to send
        them to the server:
      </P>
      <Table
        head={['Key', 'Content and purpose']}
        rows={[
          ['ws_client_id', 'A random identifier for this browser so you get your seat back after a dropped connection. Not linked to your identity and not usable to recognise you across devices.'],
          ['ws_seat_<room>', 'Secret token for your seat in a room.'],
          ['ws_host_<room>', 'Token proving your host status in a room.'],
          ['ws_nickname', 'Your last nickname, so you need not retype it.'],
          ['ws_theme, ws_sound', 'Your light/dark and notification-sound preferences.'],
          ['ws_caption_lang', 'Your last subtitle language.'],
          ['ws_legal_lang', 'The language you last read this page in.'],
        ]}
      />
      <P>
        <strong className="text-text">Legal basis:</strong> § 25(2)(2) TDDDG — this storage is strictly necessary to
        provide the service you explicitly requested, so no consent is required; for the subsequent processing,
        Art. 6(1)(b) and (f) GDPR. You can delete these values at any time via your browser settings ("clear site
        data"); afterwards you count as a new visitor and lose the seat and host tokens of any running room.
      </P>

      <H>6. Optional account</H>
      <P>
        You only need an account to reserve a permanent room name (e.g. <code>/r/movie-night</code>).{' '}
        <strong className="text-text">No email address</strong> or other contact detail is requested. Stored in a
        database on the server:
      </P>
      <UL>
        <li>username and display name (freely chosen)</li>
        <li>password — only as an Argon2id hash; the password itself is never stored</li>
        <li>registration timestamp</li>
        <li>the room names you reserved, with their timestamps</li>
        <li>
          active sessions: a hash of the session token plus creation, expiry and last-used timestamps (no IP address,
          no device name)
        </li>
      </UL>
      <P>
        Signing in sets a strictly necessary <code>ws_session</code> cookie (HttpOnly, SameSite=Lax, 30 days, extended
        as you keep using it). It holds nothing but a random token and only keeps you signed in. Signing out deletes it
        and removes the session on the server; expired sessions are purged automatically.
      </P>
      <P>
        <strong className="text-text">Legal basis:</strong> Art. 6(1)(b) GDPR (providing the account you asked for),
        and § 25(2)(2) TDDDG for the session cookie.
      </P>

      <H>7. Video sources and third parties</H>
      <SubH>7.1 YouTube</SubH>
      <P>
        YouTube videos are played through YouTube's official player. Your browser therefore loads code directly from{' '}
        <code>www.youtube.com</code>, the player runs in an embedded YouTube frame, thumbnails come from{' '}
        <code>i.ytimg.com</code>, and subtitles are fetched from YouTube. In doing so Google necessarily receives your
        IP address, information about your browser and device, and the fact that YouTube was accessed from this site;
        Google may set or read its own cookies and, if you are signed in to a Google account, associate the usage with
        it.
      </P>
      <P>
        <strong className="text-text">Important:</strong> this connection is only made the moment a YouTube video is
        actually played. Simply opening the start page or a room loads nothing from Google — Google learns nothing
        about your visit at all.
      </P>
      <P>
        The provider is Google Ireland Limited, Gordon House, Barrow Street, Dublin 4, Ireland for users in the EEA;
        data is transferred to Google LLC in the USA. Google LLC is certified under the EU-US Data Privacy Framework,
        so the European Commission's adequacy decision under Art. 45 GDPR covers that transfer. What Google does with
        the data is set out in <A href={GOOGLE_PRIVACY}>Google's privacy policy</A>. The operator of this site has no
        influence over that processing.
      </P>
      <P>
        <strong className="text-text">Legal basis:</strong> Art. 6(1)(b) GDPR — the embed is necessary to provide
        the function you asked for (watching this YouTube video together); additionally Art. 6(1)(f) GDPR and
        § 25(2)(2) TDDDG for the technically required access to your device. If you want to avoid even that, do not
        play YouTube links and block <code>youtube.com</code> in your browser, for instance with a content blocker.
      </P>

      <SubH>7.2 Every other source</SubH>
      <P>
        Direct video files, HLS streams and links to other portals are fetched <em>by the server</em>, processed there
        and delivered to you from this site. The original source therefore only ever sees the server's IP address, not
        yours. Video titles are looked up server-side too. No external scripts, fonts or tracking pixels are embedded.
      </P>

      <H>8. Recipients</H>
      <UL>
        <li>the other participants of a room (nickname, chat, reactions, chosen videos)</li>
        <li>Google, to the extent described in section 7.1</li>
        <li>
          the provider of the server this instance runs on, as a processor under Art. 28 GDPR
          {CONTROLLER.hoster ? `: ${CONTROLLER.hoster}` : ''}
        </li>
      </UL>
      <P>
        No data is passed on beyond that. Disclosure to authorities happens only where legally required.
      </P>

      <H>9. Retention at a glance</H>
      <Table
        head={['Data', 'Retention']}
        rows={[
          ['Room, chat, queue, participants', 'deleted 5 minutes after the last participant leaves'],
          ['Chat history within a room', 'only the last 80 messages'],
          ['Server logs', 'local to the server only, never analysed; deleted at the latest when the service is updated or rebuilt'],
          ['IP in the rate limiter', 'at most 10 minutes after the last request'],
          ['Account data', 'until you ask for the account to be deleted'],
          ['Sessions', '30 days from last use; immediately on sign-out'],
          ['Reserved room names', 'until you release them or the account is deleted'],
          ['Data in your browser', 'until you clear site data'],
        ]}
      />

      <H>10. No automated decision-making</H>
      <P>
        There is no automated decision-making, including profiling, within the meaning of Art. 22 GDPR. No data is
        processed for advertising, market research or audience measurement.
      </P>

      <H>11. Your rights</H>
      <P>You have the following rights against the controller:</P>
      <UL>
        <li>
          <strong className="text-text">Access</strong> to the data held about you (Art. 15 GDPR)
        </li>
        <li>
          <strong className="text-text">Rectification</strong> of inaccurate data (Art. 16 GDPR)
        </li>
        <li>
          <strong className="text-text">Erasure</strong> (Art. 17 GDPR) — an account is deleted in full on an informal
          request
        </li>
        <li>
          <strong className="text-text">Restriction</strong> of processing (Art. 18 GDPR)
        </li>
        <li>
          <strong className="text-text">Data portability</strong> (Art. 20 GDPR)
        </li>
        <li>
          <strong className="text-text">Objection</strong> to processing based on Art. 6(1)(f) GDPR (Art. 21 GDPR)
        </li>
        <li>
          <strong className="text-text">Withdrawal</strong> of consent with future effect (Art. 7(3) GDPR)
        </li>
      </UL>
      <P>
        An informal message to{' '}
        <a href={`mailto:${CONTROLLER.email}`} className="text-accent underline-offset-2 hover:underline">
          {CONTROLLER.email}
        </a>{' '}
        is enough. Because rooms and chats exist only in memory and expire automatically, for pure guest use there is
        usually no stored data left to give access to.
      </P>
      <P>
        You also have the right to{' '}
        <strong className="text-text">lodge a complaint with a data protection supervisory authority</strong>{' '}
        (Art. 77 GDPR), in particular in the EU member state of your residence, place of work, or the place of the
        alleged infringement.{' '}
        {CONTROLLER.authority ? (
          <>The authority competent for the controller is: {CONTROLLER.authority}.</>
        ) : (
          <>
            A list of the German authorities is available <A href={AUTHORITY_LIST}>from the BfDI</A>.
          </>
        )}
      </P>

      <H>12. Security</H>
      <P>
        The connection is encrypted with HTTPS/TLS. Passwords are stored only as Argon2id hashes and session tokens
        only as hashes. The session cookie is HttpOnly and SameSite=Lax, complemented by a strict Content Security
        Policy and further security headers. No one can guarantee complete security of data transmission over the
        internet.
      </P>

      <H>13. Minors</H>
      <P>
        This service is not directed at children. People under 16 should use it only with the consent of a parent or
        guardian.
      </P>

      <H>14. Changes to this notice</H>
      <P>
        This notice is updated when the app changes; the version published here applies. Last updated:{' '}
        {LAST_UPDATED.en}.
      </P>
      <P className="text-xs">
        Note: WatchSync is run purely privately and not on a commercial basis, so the German provider-identification
        duty ("Impressum", § 5 DDG) does not apply. GDPR obligations apply regardless and are met by this notice.
      </P>
    </>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

function initialLang(): Lang {
  const saved = localStorage.getItem(LANG_KEY);
  if (saved === 'de' || saved === 'en') return saved;
  return navigator.language?.toLowerCase().startsWith('de') ? 'de' : 'en';
}

export default function Privacy() {
  const [lang, setLang] = useState<Lang>(initialLang);

  useEffect(() => {
    localStorage.setItem(LANG_KEY, lang);
  }, [lang]);

  function choose(next: Lang) {
    setLang(next);
  }

  return (
    <div className="min-h-screen bg-bg px-4 py-10">
      <div className="mx-auto w-full max-w-3xl">
        <div className="mb-8 flex flex-wrap items-center justify-between gap-3">
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              navigate('/');
            }}
            className="text-sm text-dim underline-offset-2 transition hover:text-text hover:underline"
          >
            ← {lang === 'de' ? 'Zurück zu WatchSync' : 'Back to WatchSync'}
          </a>
          <div className="flex gap-1 rounded-lg border border-border p-1 text-xs" role="group">
            {(['de', 'en'] as Lang[]).map((l) => (
              <button
                key={l}
                onClick={() => choose(l)}
                aria-pressed={lang === l}
                className={`rounded px-2.5 py-1 font-medium uppercase transition ${
                  lang === l ? 'bg-accent text-white' : 'text-dim hover:text-text'
                }`}
              >
                {l}
              </button>
            ))}
          </div>
        </div>

        <h1 className="mb-2 text-3xl font-bold tracking-tight">
          {lang === 'de' ? 'Datenschutzerklärung' : 'Privacy Policy'}
        </h1>
        <p className="mb-8 text-sm text-dim">
          {lang === 'de' ? `Stand: ${LAST_UPDATED.de}` : `Last updated: ${LAST_UPDATED.en}`}
        </p>

        <div lang={lang}>{lang === 'de' ? <German /> : <English />}</div>

        <footer className="mt-12 border-t border-border pt-6 text-center text-xs text-dim">
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              navigate('/');
            }}
            className="underline-offset-2 transition hover:text-text hover:underline"
          >
            WatchSync
          </a>
        </footer>
      </div>
    </div>
  );
}
