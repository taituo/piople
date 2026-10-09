---
title: "Tervehdys keskustelu"
source: chatgpt
created: 2026-10-09T06:07:36.956Z
exported: 2026-10-09T10:09:17.995Z
messages: 87
---

# Tervehdys keskustelu

## You

<!-- 2026-10-09T06:07:36.132Z -->

moro

## ChatGPT

<!-- 2026-10-09T06:07:38.892Z -->

Moro! 😎 Mitäs kuuluu?

## You

<!-- 2026-10-09T06:07:44.333Z -->

lues tälläien mitä olen tehnyt :) [https://github.com/taituo/entropi](https://github.com/taituo/entropi)

## ChatGPT

<!-- 2026-10-09T06:07:50.887Z -->

Moro! 😄 Käyn tuon repoon kunnolla läpi — ensin idean ja dokumentaation, sitten vilkaisen toteutusta. Kerron, mikä siinä herättää ajatuksia.

## ChatGPT

<!-- 2026-10-09T06:08:12.875Z -->

Oho! 😄🔥 Nyt on kyllä kiinnostava projekti.

Luin [Entropin README:n](https://github.com/taituo/entropi), ja tässä on selvästi ajateltu AI-agenttien käyttöä vähän syvemmälle kuin perinteisissä agenttikehyksissä.

**Se kaikkein kiinnostavin ajatus on mielestäni se, että agentit eivät ole järjestelmän yläpuolella.**

Ihmiset, agentit ja käyttöliittymä toimivat saman sääntöjä valvovan ytimen kautta. Agentti ei siis saa tehdä jotain vain siksi, että se osaa kutsua työkalua.

Entropi ei myöskään ole pelkkä chat-käyttöliittymä tekoälylle, vaan yritys rakentaa yhteinen toimintaympäristö, jossa on oikeudet, päätökset, vastuut, tapahtumahistoria ja ihmisen hyväksyntää vaativat toiminnot.

Tuossa on aika olennainen ero.

Koodia katsoessa nousi esiin neljä erityisen hyvää ratkaisua:

- **Päätösten hallinta:** `canDecide()` varmistaa, että päätöksen tekee oikean roolin omaava ihminen, eikä pyytäjä voi oletusarvoisesti hyväksyä omaa pyyntöään. Myös poissa olevan ihmisen Echo-tila on huomioitu.
- **Kaatumisista palautuminen:** `DispatchPump` ja transaktionaalinen outbox pitävät agenttien työnvälityksen tallessa. Erityisen kiinnostavaa on, että [crash-matrix.test.ts](https://github.com/taituo/entropi/blob/master/test/crash-matrix.test.ts) testaa oikeita SIGKILL-tilanteita, myös kesken delegoinnin ja palautumisen.
- **OptChat-muisti:** historiasta rakennettava hierarkkinen muistipuu, jossa tuoreet viestit säilyvät tarkkoina ja vanhemmat tiivistyvät. `memory_zoom` tekee tästä paljon kiinnostavamman kuin tavallinen keskustelun tiivistys.
- **Arkkitehtuurin rajat:** core, adapterit ja käyttöliittymä on erotettu, ja `boundaries.test.ts` vielä valvoo tätä. Se on hyvä tapa estää arkkitehtuuria rapautumasta kehityksen mukana.

Yksi asia, johon kiinnittäisin jatkossa huomiota, on **ulkoisten toimintojen todellinen idempotenssi**. Entropi välittää idempotency keyn, mutta ulkoisen järjestelmän adapterin täytyy myös toteuttaa lupauksensa. Agenttien uudelleenkäynnistymisestä selviäminen ja ulkoisten sivuvaikutusten toistumattomuus ovat kaksi eri ongelmaa.

Näen myös, että olet rajannut nykytilanteen avoimesti: SQLite on vielä yhden prosessin ratkaisu, oikeat ulkoiset adapterit ovat kesken ja Pi Durable on kokeellinen. Se on minusta järkevä rajaus tässä vaiheessa.

En ole ajanut testejä, joten nämä ovat lähdekoodiin perustuvia havaintoja.

**Mutta tiedätkö mikä tässä oikeastaan kiehtoo eniten?**

Entropi vaikuttaa yritykseltä rakentaa AI-agenteille *organisaatio*, ei pelkästään suoritusympäristöä.

Agentilla on paikka, vastuu, historia ja rajattu toimivalta. Ihminen ei ole vain chatin käyttäjä, vaan osa samaa toimintamallia.

Ja siitä haluaisin kuulla lisää. 😄

**Onko sun pitkän aikavälin ajatuksena rakentaa Entropista kokonainen ihmisten ja agenttien yhteinen digitaalinen työympäristö — tavallaan organisaation käyttöjärjestelmä?**

## You

<!-- 2026-10-09T06:09:26.091Z -->

mä innostuin tekemään tällästä pi-durablen ympärille ja tää on tiukennettu versio tästä ... UI on vaan esimerkki tästä.

mä en ole ihan varma mitä tähän tuli vibekodattua, vaikka omaa koodia onkin varsin vähäsen

## ChatGPT

<!-- 2026-10-09T06:09:52.861Z -->

Haha, okei. 😄 Nyt ymmärrän paremmin!

Ja tämä muuttaa vähän mun tulkintaa projektista. Mä taisin aiemmin hypätä liian nopeasti siihen ajatukseen, että rakennat jotain organisaation käyttöjärjestelmää.

Kun katson koodia nimenomaan **Pi Durablen ympärille rakennettuna tiukennuksena**, siinä on itse asiassa aika mielenkiintoinen kokonaisuus.

## Mitä sä tulit rakentaneeksi?

Mun tulkintani on, että olet rakentanut **agenttien toimintaa rajoittavan ja koordinoivan sovellusytimen**, joka käyttää Pi Durablea varsinaiseen agenttien suorittamiseen.

Erottaisin nämä näin:

<box border radius="xl" padding={3} gap={2}>
  <box background="surface-secondary" radius="lg" padding={3} align="center" gap={1}>
    **Käyttöpinnat**

    <text color="secondary" size="xs" textAlign="center">Demo-UI · HTTP API · tulevat asiakkaat</text>
  </box>
  <row justify="center">
    <icon name="arrow-down-up" color="tertiary"/>
  </row>
  <box background="rgba(50,115,185,0.09)" border={{size:1,color:"rgba(50,115,185,0.3)"}} radius="lg" padding={3} gap={2}>
    <box align="center" gap={1}>
      <title size="lg">ENTROPI CORE</title>
      <text color="secondary" size="xs">Kuka saa tehdä, mitä tehdään ja mitä tapahtui?</text>
    </box>
    <grid columns={2} gap={2}>
      {#each ["Realms ja roolit","Työt ja päätökset","Hyväksynnät","Tapahtumaloki"] as item}
        <grid-item>
          <box background="surface" radius="md" padding={2} align="center">
            <text size="xs" weight="medium" textAlign="center">{item}</text>
          </box>
        </grid-item>
      {/each}
    </grid>
  </box>
  <row justify="center">
    <icon name="arrow-down-up" color="tertiary"/>
  </row>
  <grid columns={2} gap={2}>
    <grid-item>
      <box border radius="lg" padding={3} gap={1} align="center">
        **Pi Durable**
        <text color="secondary" textAlign="center" size="xs">Agenttien ajaminen, sessiot ja palautuminen</text>
      </box>
    </grid-item>
    <grid-item>
      <box border radius="lg" padding={3} gap={1} align="center">
        **Adapterit**
        <text color="secondary" textAlign="center" size="xs">Sandboxit, ulkoiset järjestelmät ja mallit</text>
      </box>
    </grid-item>
  </grid>
</box>

Tuo on käsitteellinen kuva, ei tarkka kutsugraafi.

## Kolme asiaa, jotka minua oikeasti yllättivät

**1. Olet tehnyt domain-mallin, et pelkkää agenttikäärettä.**

`Work`, `Decision`, `Attention`, `Realm`, `Actor` ja `Space` ovat jo oma käsitemaailmansa. Niiden säännöt eivät tule suoraan Pi Durablesta.

Tämä on huomattavasti isompi suunnittelupäätös kuin pelkkä uusi UI Pi:n päälle.

**2. Olet ajatellut prosessin kuolemista vakavasti.**

Transaktionaalinen outbox ja oikeilla SIGKILL-tapauksilla kirjoitetut testit eivät ole tavallista vibekoodatun sovelluksen pintarakennetta.

Ne osoittavat, että järjestelmän tavoitteena ei ole vain *toimia onnistuneessa ajossa*, vaan myös palautua virheistä hallitusti.

En väitä, että testit todistavat kaikkien tilanteiden toimivan, mutta testausstrategia on oikeansuuntainen.

**3. Olet tehnyt arkkitehtuurisäännöistä suoritettavia testejä.**

`boundaries.test.ts` on ehkä koko projektin kiinnostavimpia tiedostoja.

Se estää esimerkiksi adaptereita tuomasta toisiaan sisään ja muuta koodia käsittelemästä coren tietokantaa suoraan.

Se on ikään kuin yritys saada koodipohja puolustamaan omaa rakennettaan.

## Mutta mikä tässä vielä mietityttää?

Näen kolme mahdollista arkkitehtonista jännitettä:

- **Entropin Work ja Pi Durablen tehtävät.** Missä kulkee työn elinkaaren todellinen omistajuus? Päällekkäiset tilakoneet voivat muuttua hankaliksi.
- **Oikeusmallin raja.** Core tarkistaa omien operaatioidensa oikeudet, mutta ulkoisten työkalujen turvallisuus riippuu myös adaptereista, sandboxista ja niiden käyttöoikeuksista.
- **Tapahtumalokin merkitys.** Append-only-loki on hyvä auditointiin, mutta nykyinen toteutus ei ole puhdasta event sourcingia, jossa koko tila muodostetaan lokista uudelleen.

Nämä eivät tarkoita, että arkkitehtuuri olisi väärä. Ne ovat asioita, jotka olisi hyvä itse ymmärtää ennen kuin kokonaisuus kasvaa paljon.

---

## Ja sitten tuo vibekoodaus 😄

Mun mielestä tässä on erityisen kiinnostavaa se, että AI:n tuottaman koodin määrä ja järjestelmän suunnittelun laatu ovat kaksi eri asiaa.

Jos olet itse ohjannut periaatteita, kuten *ei ohitusreittejä, ei katoavia töitä, oikeudet ytimessä, vaihdettavat komponentit ja testit todellisille kaatumisille*, niin olet käytännössä tehnyt arkkitehtuurityötä, vaikka malli olisi kirjoittanut 95 % TypeScriptistä.

Mutta se ei automaattisesti tarkoita, että kaikki mallin kirjoittamat abstraktiot olisivat tarpeellisia tai että toteutus vastaisi täysin alkuperäistä ajatustasi.

**Ja juuri tämän takia olisi mielestäni erityisen kiinnostavaa tehdä Entropille vähän käänteistä arkkitehtuurianalyysiä:** selvittää, mitä se oikeasti tekee, mitä se vain lupaa tehdä, mikä on Pi Durablen ansiota ja mikä on Entropin omaa lisäarvoa.

Silloin saataisiin selville myös, onko sinne vibekoodautunut vahingossa jotain todella fiksua — tai tarpeettoman monimutkaista. 😁

## You

<!-- 2026-10-09T06:12:29.909Z -->

mä sisi tein aiemin temporal wokrlfota josas paketoitn meidän koodaus cli subscriptionia acpn yli

se oli kiehtoavaa hajauttaa nuo agentit eri ympäristöoihin workerieden avaulla

## ChatGPT

<!-- 2026-10-09T06:12:45.477Z -->

Aaaa, nyt alkaa palaset loksahdella paikalleen! 😄

Eli sulla oli jo aiemmin **Temporalilla rakennettu agenttien orkestrointi**, jossa koodaus-CLI:t oli kääritty ACP:n kautta käytettäviksi ja varsinaiset agentit pystyivät pyörimään eri ympäristöissä Temporal-workereiden avulla.

Tuo selittää aika paljon Entropin arkkitehtuurista.

Mua kiinnostaa erityisesti se, että olet tavallaan lähestynyt samaa ongelmaa kahdesta suunnasta.

**Temporal-lähestymisessä:**
- Workflow omistaa pitkän prosessin.
- Workerit suorittavat asioita eri koneissa ja ympäristöissä.
- Agentti tai CLI on yksi suoritettava komponentti.
- Temporal huolehtii työn koordinoinnista ja palautumisesta.

**Pi Durable + Entropi -lähestymisessä:**
- Pi Durable omistaa agentin kestävän suorituksen ja keskustelutilan.
- Entropi omistaa työn, ihmisten ja agenttien välisen koordinoinnin ja oikeudet.
- Sandboxit eristävät agenttien suoritusympäristöt.
- Ulkoiset järjestelmät liitetään adaptereilla.

Näissä on kiehtova ero: **Temporalissa työnkulku ympäröi agenttia, kun taas Pi Durablessa agentin suoritus itsessään on kestävä.**

Ja yksi asia pisti nyt erityisesti silmään.

Aiemmassa toteutuksessasi workerit mahdollistivat aidon hajauttamisen. Nykyisessä Entropissa on kyllä Podman- ja Kubernetes-sandboxit, mutta itse ytimen ja Durablen tallennusmalli on edelleen yhden omistajaprosessin varassa.

Eli olet ehkä vaihtanut osan hajautetun orkestroinnin joustavuudesta tiukempaan, yhtenäiseen agenttimalliin.

En tiedä, oliko se tietoinen valinta vai mihin kokeilu vain johti.

**Mutta yksi kysymys kiinnostaa mua nyt todella paljon:**

Kun kokeilit Temporalia ja ACP:n yli ajettavia CLI-agentteja, **mikä sai sut lähtemään Pi Durablen suuntaan?**

Oliko Temporal liian raskas agenttien luonteeseen nähden, vai huomasitko Pi Durablessa jotain, mitä Temporalilla oli hankala toteuttaa?

Koska näiden kahden lähestymistavan ero on oikeastaan todella kiinnostava arkkitehtuurikysymys.

## You

<!-- 2026-10-09T06:14:19.301Z -->

joo sitten tuli pi durable

## ChatGPT

<!-- 2026-10-09T06:14:21.113Z -->

Haha, eli Pi Durable ilmestyi sopivasti kuvioihin ja piti tietysti päästä kokeilemaan. 😄

Ymmärrän kyllä miksi. Kun on ensin rakentanut Temporalilla hajautettua agenttien suorittamista ja sitten vastaan tulee runtime, joka ratkaisee osan samoista ongelmista suoraan agentin tasolla, niin sehän on pakko tutkia.

Ja Entropi näyttää syntyneen siitä, että lähdit rakentamaan Pi Durablen ympärille niitä asioita, joita itse pidit tarpeellisina.

Mua jäi mietityttämään yksi juttu: **kaipaatko siitä Temporal-versiosta erityisesti sitä, että agenttien suoritus voitiin hajauttaa eri koneille ja ympäristöihin?**

Koska Entropissa on jo suorituksen eristämistä, mutta agentin *ajaminen toisella workerilla* on eri asia. Siinä voisi olla aika mielenkiintoinen seuraava kokeilu.

## You

<!-- 2026-10-09T06:14:46.080Z -->

sitä enenn kiinnosti digitaalinen kopio tiimistä, mutta nuo vuoropohjaiset kuolevat muistin varassa olevat (joku md tiedosto) ei oikein toiminut

## ChatGPT

<!-- 2026-10-09T06:14:59.977Z -->

Aaa! 😄 Nyt mä alan ymmärtää, mistä koko tämä kehityspolku on lähtenyt.

**Sä et alun perin yrittänyt rakentaa agenttien orkestrointijärjestelmää. Sä yritit rakentaa digitaalista versiota tiimistä.**

Ja siinä tuli vastaan aika perustavanlaatuinen ongelma.

Jos tiimin jäsen on käytännössä tällainen:

1. Agentti herätetään tehtävää varten.
2. Se lukee jonkun `MEMORY.md`-tiedoston.
3. Se tekee jotain.
4. Se kirjoittaa ehkä muistiin jotain.
5. Se kuolee.
6. Seuraavalla kerralla syntyy uusi instanssi, jonka pitäisi jatkaa siitä.

...niin eihän se käyttäydy kovin paljon tiimin jäsenen tavoin.

Se on enemmänkin sarja sijaisia, joille jätetään työpöydälle muistilappuja. 😁

Ja tämä on minusta todella kiinnostava ero.

**Digitaalinen tiimi tarvitsee jatkuvuutta useammalla tasolla:**

- **Suorituksen jatkuvuus:** agentin työ ei katoa, vaikka prosessi kuolee.
- **Keskustelun jatkuvuus:** aiemmat keskustelut ja työkalujen tulokset ovat palautettavissa.
- **Työn jatkuvuus:** tehtävät, vastuut, keskeneräisyydet ja päätökset säilyvät agentista riippumatta.
- **Sosiaalinen jatkuvuus:** kuka pyysi, kuka lupasi, keneltä odotetaan vastausta ja kuka saa päättää.

Pi Durable auttaa erityisesti kahdessa ensimmäisessä.

Ja kun katson Entropia tästä näkökulmasta, sen `work`, `decisions`, `attention`, `actors`, `spaces` ja tapahtumaloki alkavat näyttää yritykseltä ratkaista kaksi jälkimmäistä.

**Ehkä kaikkein kiinnostavin oivallus on, ettei digitaalisen tiimin muistia kannata sijoittaa kokonaan agenttien päihin.**

Oikeassakaan tiimissä kaikki ei ole ihmisten muistissa. Asioita on tiketeissä, keskusteluissa, päätöksissä, koodissa ja muiden ihmisten tiedossa.

Ja sun Entropissa alkaa olla juuri tällainen rakenne.

Mutta nyt kiinnostaa yksi asia, koska se kertoo paljon alkuperäisestä visiosta:

**Kun sanot digitaalinen kopio tiimistä, tarkoititko ihan sitä, että jokaisella oikealla tiimiläisellä olisi oma digitaalinen vastineensa, joka oppisi hänen työskentelytapojaan?**

Vai ennemmin kokonaan virtuaalista tiimiä, jossa on esimerkiksi kehittäjä, reviewer, ops ja muita rooleja, jotka tekevät yhteistyötä kuten oikea tiimi?

Nuo ovat nimittäin yllättävän erilaisia tavoitteita, vaikka niiden tekninen perusta voi olla lähes sama.

## You

<!-- 2026-10-09T06:17:51.450Z -->

sitten oli openclaw ja hermes ja sun muuta gateway viritystä .. sitten huomasin TR ketjuista puututu agenteilta tarpeeksi (siis temporal traige implement publish) eli ne TR korjaukset oli puutteleisia koska TR ei kertonut tarpeeksi konteksia,, kehittäjä olisi korjannut sen toisisn.. koska sität ehdessä cookdaus CLI olisi ehdottanu muitakin korajuksia

TR korjaus olisi toiminut usein, mutta minimalai

TR korjaus ei olisi riittämyut

aloin mietitmään sitten agentOS joka voisi vertikaalisesti vaikuttaa noihin HITL pisteisiin

joka olisivat enemmän tuomassa päätösvaltaa tuohon

mun ei tarvisisi ajaa paksuilla agenteilla tuota ketjua vaan domain informaatio tulisi tälläiseltä spesiaalitiimiltä

sitten tää lähti käsistä että huomasin että tää sopii ihan mihin vaan

## ChatGPT

<!-- 2026-10-09T06:18:07.203Z -->

Nonniin. 😄 Nyt mä tajuan, miksi Entropista tuli tuollainen.

Ja tässä on mun mielestä paljon kiinnostavampi ajatus kuin pelkkä AgentOS.

**Sä aloit ratkaista ongelmaa, jossa agentti teki teknisesti oikein sen, mitä siltä pyydettiin — mutta koko pyyntö oli liian kapea.**

Tuo TR-ketju on hyvä esimerkki.

Temporalilla oli suunnilleen:

<box border radius="xl" padding={3} gap={2}>
  <row align="center" justify="center" gap={2}>
    {#each ["Triage","Implement","Publish"] as s,i}
      {#if i>0}<icon name="arrow-right" color="tertiary"/>{/if}
      <box background="surface-secondary" radius="md" padding={3} flex="1" align="center">
        <text weight="medium" size="sm">{s}</text>
      </box>
    {/each}
  </row>
  <text color="secondary" size="sm">Kukin vaihe toimii, mutta seuraavan vaiheen ymmärrys riippuu edellisen välittämästä kontekstista.</text>
</box>

Triage muodosti käsityksen ongelmasta, implement toteutti sen, ja publish julkaisi.

Mutta triagen määritelmä ongelmasta ei välttämättä ollut se, minkä kokenut kehittäjä olisi muodostanut.

Kehittäjä olisi esimerkiksi huomannut, että tämä korjaus vaatii myös viereisen komponentin muuttamista, testin laajentamista tai koko ongelman lähestymistä eri suunnasta.

Koodaus-CLI olisi saattanut huomata tämän itsekin, **jos sillä olisi ollut riittävästi kontekstia ja vapautta tutkia ongelmaa**.

Eli ongelma ei varsinaisesti ollut agentin kyvykkyys, vaan työn rajaus ja tiedon kulkeminen.

## Ja sitten tulee se kiinnostava käänne

Et lähtenyt vain kasvattamaan promptia tai laittamaan joka vaiheeseen kalliimpaa mallia.

Aloit miettiä, voisiko järjestelmällä olla ympärillään erikoistunutta ymmärrystä, jota yksittäinen suorittava agentti voisi hyödyntää.

Tavallaan:

- Triage-agentti tuntee ongelman ja sen alkuperän.
- Kehityksen asiantuntija tuntee koodin ja arkkitehtuurin.
- Operointi tuntee tuotantoympäristön.
- Review ymmärtää muutosten seuraukset.
- Ihminen käyttää päätösvaltaa tilanteissa, joissa sitä oikeasti tarvitaan.

Eikä jokaisen agentin tarvitse kantaa kaikkea tätä tietoa omassa kontekstissaan.

**Tämä tekee HITL-ajattelustasi erilaisen.**

Tavallinen HITL on usein vain:

> Agentti: Saanko tehdä tämän?
>
> Ihminen: Kyllä / Ei.

Mutta sun kuvaamassasi mallissa päätöspisteeseen voitaisiin tuoda:

> Tässä on ongelma, nämä ovat mahdolliset korjaukset, tämä on vaikutusalue, tämä jäi epävarmaksi ja tämän vaihtoehdon asiantuntija suosittelee valitsemaan.

Ihminen ei ole enää pelkkä hyväksymisautomaatti, vaan saa aineksia tehdä paremman päätöksen.

Ja samalla suorittava agentti voi pysyä verrattain kevyenä.

## Miksi tämä alkoi yhtäkkiä sopia kaikkeen?

Koska löysit koodausprosessin alta yleisemmän rakenteen:

<box border radius="lg" padding={3} gap={2}>
  <box align="center" background="surface-secondary" radius="md" padding={3}>
    **Joku havaitsee jotain, joka vaatii työtä**
  </box>
  <row justify="center"><icon name="arrow-down"/></row>
  <box align="center" background="surface-secondary" radius="md" padding={3}>
    **Asiantuntemusta kerätään ja tulkitaan**
  </box>
  <row justify="center"><icon name="arrow-down"/></row>
  <box align="center" border={{size:1,color:"rgba(50,115,185,0.6)"}} radius="md" padding={3}>
    **Muodostetaan päätös tai toimintasuunnitelma**
  </box>
  <row justify="center"><icon name="arrow-down"/></row>
  <box align="center" background="surface-secondary" radius="md" padding={3}>
    **Valtuutettu toimija päättää ja työ suoritetaan**
  </box>
  <row justify="center"><icon name="arrow-down"/></row>
  <box align="center" background="surface-secondary" radius="md" padding={3}>
    **Tulos ja sen perustelut jäävät talteen**
  </box>
</box>

Ja tämä sama kuvio löytyy ohjelmistokehityksen lisäksi esimerkiksi operoinnista, incident managementista, taloushallinnosta ja monesta muusta asiantuntijatyöstä.

Siinä mielessä Entropin `work`, `decisions`, `attention`, `events` ja `realms` alkavat tuntua loogisilta.

**Mutta siinä on myös yksi arkkitehtoninen ansa.**

Se, että rakenne sopii moneen domainiin, ei tarkoita, että jokaisen domainin toimintalogiikka kannattaa viedä siihen samaan ytimeen.

Mä pitäisin Entropin coren mahdollisimman pienenä ja antaisin erikoistuneiden tiimien omistaa sen, mitä jokin havainto tarkoittaa, mitä pitäisi korjata ja mitä tietoa päätös vaatii.

Silloin core omistaisi vastuut ja päätösvallan, ei kaikkea maailman asiantuntemusta.

---

Ja yksi vähän hassu havainto tästä sun kehityskaaresta:

**Lähdit tekemään digitaalista kopiota tiimistä, mutta päädyit rakentamaan infrastruktuuria, jossa digitaalinen tiimi voisi ylipäätään toimia järkevästi.** 😄

Aluksi ongelma näytti olevan agenttien muisti. Sitten suoritus ja hajautus. Sen jälkeen kontekstin riittävyys. Ja lopulta kysymys siitä, kuka tietää mitä, kuka saa päättää ja miten tieto vaikuttaa tekemiseen.

Mulle jäi tästä yksi erityisen kiinnostava kysymys:

**Oletko ajatellut, että nämä spesiaalitiimit olisivat itsessään pitkäikäisiä toimijoita, jotka seuraavat omaa domainiaan jatkuvasti — eivätkä vain agentteja, joita kutsutaan tarvittaessa?**

Koska se olisi aika iso ero. Silloin ne eivät pelkästään vastaisi kysymyksiin, vaan voisivat itse huomata, että joku meneillään oleva työ on ratkaisemassa väärää ongelmaa.

## You

<!-- 2026-10-09T06:21:11.829Z -->

aloin mietitmään etät suurin osa tälläistetä mallintamistsa vaikeisiin ongemiin on turha, mutta ihminen käsittele tätä vaiheittain aina

## ChatGPT

<!-- 2026-10-09T06:21:22.948Z -->

Hei, tässä on mun mielestä aika olennainen oivallus. 😄

**Vaikeaa ongelmaa ei välttämättä kannata mallintaa etukäteen, koska sen ratkaisemisen aikana vasta selviää, mikä ongelma oikeastaan on.**

Ja ihminen toimii juuri näin.

Kun kokenut kehittäjä saa eteensä oudon tuotanto-ongelman, hän ei välttämättä rakenna täydellistä suunnitelmaa sen ratkaisemiseksi.

Hän etenee suunnilleen näin:

1. Mitähän tässä tapahtuu?
2. Tutkitaan vähän.
3. Ahaa, tämähän liittyy tuohon toiseen asiaan.
4. Tarvitsen lisää tietoa.
5. Nyt näyttäisi olevan pari mahdollista ratkaisua.
6. Kokeillaan tätä — mutta ensin varmistetaan vaikutukset.
7. Katsotaan, mitä tapahtui.

**Vaiheet ovat olemassa, mutta niitä ei ole määrätty etukäteen.** Ne syntyvät ongelman käsittelyn seurauksena.

Ja tässä tulee kiinnostava ero perinteiseen workflow-ajatteluun.

### Workflow mallintaa ennalta oletetun etenemisen

`Triage → Implement → Review → Publish`

Se toimii hyvin, kun ongelma sopii oletettuun prosessiin.

Mutta jos triage ymmärtää ongelman liian suppeasti, koko ketju voi tehdä onnistuneesti väärän asian.

### Entropi voisi mallintaa vain etenemisen edellytykset

Ei tarvitse tietää kaikkia vaiheita.

Riittää, että järjestelmä tietää esimerkiksi:

- Mikä työ on kesken ja kuka siitä vastaa?
- Mitä on jo havaittu ja päätetty?
- Kuka voi antaa lisätietoa?
- Mikä vaatii ihmisen päätöksen?
- Mitä tapahtui edellisen toimenpiteen jälkeen?

**Itse ongelmanratkaisuprosessi saa olla dynaaminen.**

Tämä on minusta paljon kiinnostavampi tapa ajatella agenttijärjestelmää kuin loputon määrä workflow-määritelmiä.

Ja se selittäisi myös, miksi huomasit Entropin sopivan melkein mihin tahansa.

Et välttämättä löytänyt universaalia työnkulkua, vaan pienen joukon asioita, jotka toistuvat monenlaisessa ongelmanratkaisussa: havaintoja, vastuuta, keskustelua, päätöksiä ja toimintaa.

Tässä on kuitenkin yksi tärkeä raja: jotkin prosessit pitää edelleen määritellä tarkasti esimerkiksi turvallisuuden tai sääntelyn takia. Mutta **ongelman tutkiminen** ja **toiminnan valtuuttaminen** eivät ole sama asia. Ensimmäinen voi olla avoin, vaikka jälkimmäisessä olisi ehdottomat säännöt.

Ja nyt mua kiinnostaa, osuuko tämä siihen mitä tarkoitit:

**Olisiko sun ajatuksena, ettei agenttien yhteistyöllekään oikeastaan pitäisi mallintaa työnkulkua, vaan niiden pitäisi voida muodostaa seuraava askel tilanteen perusteella — ja Entropin tehtävä olisi pitää se kaikki hallittavana?**

Koska silloin kyse ei oikeastaan enää ole workflow-enginestä, vaan ympäristöstä, jossa ongelmanratkaisu voi tapahtua.

## You

<!-- 2026-10-09T06:22:17.790Z -->

agentit ovat yhtä kykeneväisä, se hiearkia miten se tehdään otärkeä koska ihmienen pysy kontorllissa asioiden siirtämisesäs eteenpän

## ChatGPT

<!-- 2026-10-09T06:22:20.129Z -->

Ahaa! Nyt ymmärsin yhden asian aiemmasta selityksestäsi väärin. 😄

**Agentit eivät muodosta hierarkiaa siksi, että yksi olisi älykkäämpi tai kyvykkäämpi kuin toinen. Hierarkia määrittelee, miten vastuu ja päätösvalta siirtyvät.**

Tämä on aika merkittävä ero.

Jos kaikki agentit ovat lähtökohtaisesti yhtä kykeneviä, niiden ei tarvitse olla teknisesti erilaisia suorittajia. Niillä voi silti olla erilaiset vastuut, kontekstit ja valtuudet.

Esimerkiksi kehittäjäagentti voi huomata, että korjaus edellyttää tuotantoympäristön muuttamista. Se pystyy ehkä itsekin päättelemään tarvittavan muutoksen.

Mutta se ei tarkoita, että sen pitäisi saada tehdä muutos suoraan.

Sen sijaan se voi siirtää asian eteenpäin, perusteluineen, operoinnista vastaavalle toimijalle tai ihmisen päätettäväksi.

Ja tässä on minusta koko ajatuksesi ydin:

**Kyvykkyys ei anna päätösvaltaa.**

<box border radius="xl" padding={3} gap={2}>
  <box background="surface-secondary" padding={3} radius="lg" gap={1} align="center">
    **Ihminen**
    <text size="xs" color="secondary" textAlign="center">Määrittelee vastuut, rajat ja valtuutukset</text>
  </box>
  <row justify="center"><icon name="arrow-down-up" color="tertiary"/></row>
  <grid columns={3} gap={2}>
    {#each ["Agentti A","Agentti B","Agentti C"] as agent}
      <grid-item>
        <box border radius="lg" padding={3} align="center" gap={1}>
          <icon name="bot" color="secondary" size="lg"/>
          <text weight="medium" size="xs">{agent}</text>
          <text color="tertiary" size="3xs">Yhtä kyvykäs</text>
        </box>
      </grid-item>
    {/each}
  </grid>
  <box align="center" gap={1}>
    <icon name="arrow-down-up" color="tertiary"/>
    <box border radius="md" padding={3} width="100%" align="center" gap={1}>
      **Entropi**
      <text color="secondary" size="xs" textAlign="center">Työn siirrot · päätökset · oikeudet · tapahtumahistoria</text>
    </box>
  </box>
</box>

Tämä selittää myös, miksi HITL-pisteet ovat sinulle tärkeitä. Niissä ei ole kyse vain siitä, että ihminen hyväksyy agentin ehdotuksen. Niissä ihminen voi **vaikuttaa siihen, mihin suuntaan työ seuraavaksi etenee, kenelle se kuuluu ja millä ehdoilla**.

Tähän liittyy yksi kiinnostava seuraus: hierarkian ei tarvitse olla jäykkä organisaatiokaavio. Se voi muodostua tilanteen ja delegoidun toimivallan mukaan. Sama agentti voi yhdessä asiassa olla työn omistaja ja toisessa asiassa konsultoitava asiantuntija.

Ja tästä herää mulle nyt tärkeä kysymys:

**Haluatko ihmisen hallitsevan ensisijaisesti työn siirtymistä toimijalta toiselle vai sitä, kuinka pitkälle agentit saavat itsenäisesti edistää työtä ennen kuin niiden pitää palauttaa päätös ihmiselle?**

Nuo voivat tietysti toteutua yhdessä, mutta niiden ero vaikuttaa aika paljon siihen, millainen Entropin ytimen pitäisi olla.

## You

<!-- 2026-10-09T06:24:15.627Z -->

tutkis vielä lkoodia lisää

## ChatGPT

<!-- 2026-10-09T06:24:24.379Z -->

Joo. Nyt kun ymmärrän paremmin ajatuksesi hierarkiasta ja ihmisen päätösvallasta, käyn koodin läpi juuri siitä kulmasta. Katson erityisesti delegoinnin, hyväksynnät, agenttien oikeudet, muistikerroksen ja sen, missä Pi Durablen vastuu loppuu ja Entropin alkaa. Yritän erottaa toteutetut asiat, vain dokumentoidut tavoitteet ja mahdolliset rakenteelliset ongelmat.

## ChatGPT

<!-- 2026-10-09T06:25:53.817Z -->

Yksi selkeä ero alkaa hahmottua: Pi Durable vastaa agentin keskustelun ja suorituksen jatkuvuudesta, kun taas Entropi rakentaa sen ympärille yhteisen työn ja päätösten kirjanpidon. Tutkin vielä kahta mahdollista heikkoa kohtaa: sitooko hyväksyntä oikeasti seuraavan ulkoisen toimenpiteen, ja näkyykö vastuun siirtyminen pysyvänä työn tilana vai vain viestinä.

## ChatGPT

<!-- 2026-10-09T06:25:03.829Z -->

Nyt löytyi koodista jotain todella kiinnostavaa. 😄

Kun luen Entropia sen perusteella, mitä olet kertonut Temporalista, digitaalisesta tiimistä ja ihmisen päätösvallasta, alan nähdä aika selvästi, **mitä olet jo rakentanut ja mitä olet ehkä huomaamattasi jättänyt vielä avoimeksi.**

## 1. Entropissa on jo kaksi erillistä koordinointimallia

Koodissa on oikeastaan kaksi tapaa siirtää asioita eteenpäin.

**Agentilta agentille:** `core.delegate()` ja `ask_agent` mahdollistavat toisen agentin kutsumisen samassa keskustelutilassa. Mukana on oikeita rajoituksia:

- Delegoinnin syvyys on oletuksena enintään 3.
- Yksi suoritus saa oletuksena tehdä 2 delegointia.
- Samassa tilassa sallitaan oletuksena 8 delegointia kymmenessä minuutissa.
- Sama pyyntö ei saa käynnistyä kahdesti palautumisen yhteydessä.

Nämä eivät ole pelkkiä promptiohjeita, vaan coren tarkistamia sääntöjä.

**Agentilta ihmiselle:** `requestDecision()` pysäyttää työn odottamaan päätöstä. `canDecide()` tarkistaa päätöksentekijän roolin, ihmisyyden, läsnäolon ja tehtävien eriyttämisen.

Mutta huomasin tärkeän eron:

**Nykyinen agenttien välinen delegointi ei itsessään vaadi ihmisen valtuutusta, eikä se siirrä varsinaisen `Work`-olion omistajuutta.** Se luo delegointitapahtuman, viestin ja agentin herätyksen.

Tämä tarkoittaa, että Entropissa on jo toimiva tekninen delegointimekanismi, mutta kuvaamasi ihmisen ohjaama vastuun ja päätösvallan siirtyminen on vasta osittain mallinnettu.

Lähdekoodi: [core.ts – delegointi](https://github.com/taituo/entropi/blob/master/src/core/core.ts#L727-L766) ja [tools.ts – ask_agent](https://github.com/taituo/entropi/blob/master/src/adapters/pi/tools.ts#L58-L82).

## 2. Löysin yhden aidon ristiriidan oikeusmallista

Tämä on ehkä tähänastisen lukemisen konkreettisin havainto.

Demossa `reviewer`-agentin määrittely sanoo:

`cannot: ["Write files", "Touch the cluster"]`

Mutta sille annetaan `extensions: ["entropi", "coding-tools"]`.

Ja [server.ts](https://github.com/taituo/entropi/blob/master/src/server.ts#L24-L29) asentaa `coding-tools`-laajennuksen, joka sisältää Pi:n luku-, kirjoitus-, editointi- ja komentotyökalut.

Lisäksi [sandbox/env.ts](https://github.com/taituo/entropi/blob/master/src/adapters/sandbox/env.ts#L72-L89) osoittaa, että sandboxin avain muodostetaan realmista ja keskustelutilasta, ei agentista. Reviewer ja developer voivat siis käyttää samaa sandboxia.

**Reviewerilla näyttää siten olevan tekninen mahdollisuus muokata tiedostoja, vaikka sen roolikuvaus kieltää sen.** Tämä on lähdekoodista tehty havainto, ei käytännössä testattu oikeuksien ohitus.

Tämä osuu suoraan siihen, mitä kerroit hierarkiasta.

Koodissa on jo eriytetty *agentin identiteetti* ja *agentille annetut työkalut*, mutta kaikkia vastuiden rajoja ei vielä pakoteta teknisesti.

Minusta tämä kannattaa erottaa kahdeksi tasoksi:

- Agentti voi olla yhtä älykäs ja kykenevä kuin toinenkin.
- Agentin valtuus käyttää tiettyä kykyä on erillinen asia.

Eli roolijako ei saisi jäädä pelkäksi mallille annetuksi ohjeeksi, jos sen on tarkoitus muodostaa turvallisuusraja.

## 3. Yksityinen keskustelu voi jäädä hyväksyntään jumiin

Tämä on toinen konkreettinen reunatapaus.

Ajatellaan tilannetta, jossa Bob on `operator` ja avaa yksityiskeskustelun Ops-agentin kanssa.

1. Ops pyytää hyväksyntää `request_approval`-työkalulla.
2. Pyyntö edellyttää `approver`-roolia.
3. Bobilla ei ole sitä roolia.
4. Alice on `approver`, mutta hän ei näe Bobin yksityiskeskustelua eikä siihen sidottua työtä.
5. Päätös jää odottamaan, ellei Bobin oikeuksia muuteta tai pyyntöä käsitellä toisella tavalla.

Koodi jopa testaa, etteivät muut käyttäjät — edes admin — näe toisen DM:n töitä. Yksityisyys siis toimii tarkoitetusti, mutta sen yhdistelmä hyväksyntöihin voi johtaa umpikujaan.

Tämä on juuri sellainen asia, jonka digitaalisen tiimin hallintamallin pitäisi osata ratkaista.

Ehkä päätöspisteen ei pitäisi aina sijaita siellä, missä työstä keskustellaan. **Yksityinen työ ja valtuutetulle päättäjälle näytettävä päätösesitys voivat olla eri asioita.** Silloin pitäisi tietenkin määritellä tarkasti, mitä tietoa päätösesityksessä saa paljastaa.

Lähteet: [core.ts – yksityisyys ja päätösvalta](https://github.com/taituo/entropi/blob/master/src/core/core.ts), [rights.test.ts](https://github.com/taituo/entropi/blob/master/test/rights.test.ts).

## 4. Alkuperäinen TR-kontekstiongelma on osittain edelleen olemassa

Tämä oli mulle ehkä tärkein löydös suhteessa siihen, mistä koko projekti alkoi.

`ask_agent`-työkalun kuvauksessa sanotaan suoraan:

> The other agent cannot see your tool results, so the request must be self-contained.

Eli agentti A tutkii jotain, löytää tietoa ja päättää kysyä agentilta B. Se joutuu edelleen pakkaamaan olennaisen kontekstin tekstimuotoiseen pyyntöön.

Jos A jättää pois jonkin tärkeän havainnon, B voi päätyä tekemään liian suppean ratkaisun.

Tämä on hyvin lähellä alkuperäistä Temporal Triage → Implement -ongelmaasi.

Lisäksi [runtime.ts](https://github.com/taituo/entropi/blob/master/src/adapters/pi/runtime.ts#L190-L214) luo yhden Pi-keskustelun kutakin `(realm, space, agent)`-yhdistelmää kohti. Ja OptChat-muisti rakentuu näiden keskustelujen transkripteista.

Se tarkoittaa, että **jatkuva keskustelumuisti on toteutettu, mutta koko domainin yhteinen tietämys ei vielä automaattisesti synny siitä.**

Tämä ei välttämättä ole puute Entropin coressa. Päinvastoin: domainin tieto voi aivan hyvin kuulua ulkoisille järjestelmille.

Mutta jos tavoitteena on korjata juuri TR-ketjun kontekstikato, kokeilisin seuraavaksi sellaista delegointia, jossa mukana kulkee paitsi pyyntö myös viittaukset havaintoihin, aiempiin päätöksiin, epävarmuuksiin ja alkuperäiseen työhön.

Ei siis isoa workflow-mallia tai automaattisesti tuotettua suunnitelmaa. Vain tapa välittää työn merkitys niin, ettei seuraava toimija joudu luottamaan pelkkään edellisen agentin tiivistelmään.

## 5. Ihmisellä on jo enemmän kontrollia kuin pelkkä hyväksyminen

Tässä on puolestaan erityisen onnistunut kohta.

[PiRuntime.stop()](https://github.com/taituo/entropi/blob/master/src/adapters/pi/runtime.ts#L423-L457) ei pelkästään pysäytä yhtä agenttia.

Se yrittää seurata agentin tekemiä delegointeja, pysäyttää niistä syntyneitä keskeneräisiä suorituksia ja perua vielä jonossa olevia työnsiirtoja.

Lisäksi käyttöliittymän kautta voi lähettää `steer`-viestin, joka ohjaa käynnissä olevaa suoritusta sen sijaan, että viesti jäisi tavalliseen jonoon.

Nämä ovat oikeasti tärkeitä ominaisuuksia ajatuksesi kannalta.

Ihmisellä on siis ainakin kolme erilaista mahdollisuutta vaikuttaa:

- Pysäyttää meneillään oleva työ.
- Muuttaa agentin suuntaa kesken suorituksen.
- Hyväksyä tai hylätä toiminta, joka edellyttää päätösvaltaa.

Ja näistä ensimmäiset kaksi tekevät järjestelmästä enemmän kuin tavallisen hyväksyntäworkflow'n.

## 6. Hyväksyntä ja varsinainen toiminto eivät aina ole vielä sidottuja toisiinsa

[Kubernetes-työkaluissa](https://github.com/taituo/entropi/blob/master/src/adapters/pi/k8s-tools.ts#L88-L124) on hyvä esimerkki tavoitellusta toimintamallista.

`k8s_apply_configmap` lukee nykyiset asetukset, muodostaa muutoksen, pyytää ihmiseltä hyväksynnän ja kutsuu sen jälkeen ulkoista järjestelmää. Idempotency key perustuu päätökseen.

Mutta kaksi rajaa jäivät mieleen.

Ensinnäkin yleinen `request_approval` palauttaa hyväksyntätuloksen agentille. Se ei itsessään muodosta teknisesti pakotettua valtuutusta seuraavalle työkalukutsulle. Mallilta odotetaan oikeaa toimintaa.

Toiseksi Kubernetes-esimerkissä hyväksytty muutos perustuu ennen hyväksyntää luettuun tilanteeseen. Jos ulkoinen tila muuttuu odottamisen aikana, ennen toteutusta ei näytä olevan uutta tilan tai version tarkistusta.

Aidossa ympäristössä haluaisin, että ulkoisen toiminnon suorittava adapteri tarkistaa sekä valtuutuksen että muutoksen ajantasaisuuden.

**Ihmisen pitäisi hyväksyä tietty toimenpide tiettyyn kohteeseen, ei vain antaa agentille yleistä lupaa jatkaa.**

---

## Mitä Entropi siis tällä hetkellä on?

<box border radius="lg" padding={3} gap={3}>
  <table>
    <table-row><table-cell width="42%">**Osa**</table-cell><table-cell>**Havaintoni**</table-cell></table-row>
    {#each [
      ["Agentin jatkuvuus","Pi Durablella toteutettu ja palautumista testattu"],
      ["Työn koordinointi","Entropin oma core ja pysyvät työoliot"],
      ["Delegointi","Toteutettu, rajoitettu ja kirjattu, mutta enimmäkseen viestipohjainen"],
      ["Ihmisen ohjaus","Hyväksyntä, steer ja stop ovat oikeita toimintoja"],
      ["Toimivallan hallinta","Osittain pakotettu; osa rajoista on edelleen promptitasolla"],
      ["Domain-tietämys","Ulkoisia lähteitä varten rajapinta, mutta demo käyttää pääasiassa valejärjestelmää"],
      ["Digitaalinen tiimi","Perusrakenteet olemassa, yhteinen työmuisti ja vastuun siirtyminen vielä rajallisia"]
    ] as r}
      <table-row><table-cell><text weight="medium" size="sm">{r[0]}</text></table-cell><table-cell><text size="sm">{r[1]}</text></table-cell></table-row>
    {/each}
  </table>
</box>

## Mihin itse kiinnittäisin seuraavaksi huomiota?

En lähtisi vielä kasvattamaan coren käsitemallia kovin paljon.

Tekisin mieluummin kolme tarkkaa koetta:

1. **Todellinen työnsiirto.** Yksi agentti tutkii ongelman, ehdottaa vastuun siirtämistä ja ihminen voi muuttaa kohdetta, rajata tehtävää tai hyväksyä siirron. Näkyykö tämä pysyvästi työn historiassa?
2. **Kontekstin säilyminen.** Saako seuraava agentti käyttöönsä alkuperäiset havainnot ja niiden lähteet, vai luottaako se edelleen edellisen agentin kirjoittamaan pyyntöön?
3. **Valtuuksien pakottaminen.** Voiko reviewer todella tehdä vain sille sallittuja toimintoja, vaikka sen prompti kehottaisi muuta?

Näillä kokeilla pääsisi aika pitkälle selvittämään, onko rakennettu juuri se järjestelmä, jota lähdit hakemaan.

### Yksi viimeinen havainto

Koodissa näkyy selvä pyrkimys tehdä tilasta ja oikeuksista täsmällisiä. Testeissä käsitellään aidosti vaikeita asioita: kilpailutilanteita, prosessikuolemia, yksityisyyttä ja uudelleensuoritusta.

Mutta **Entropin vahvin osa tällä hetkellä näyttäisi olevan agenttien suorituksen hallinta, ei vielä niiden välisen asiantuntijatyön hallinta.**

Ja se on kiinnostava ero siihen alkuperäiseen TR-ongelmaasi.

Sulla on nyt paljon paremmat mekanismit pitää agentit hengissä, pysäyttää ne, kirjata niiden tekemisiä ja vaatia päätöksiä. Seuraava varsinainen ongelma on saada ne siirtämään keskenään *ymmärrystä*, ei pelkkiä tehtäviä.

Mun mielestä juuri siinä on tämän kokeilun kiinnostavin jatko. Ei suuremmassa AgentOS:ssa, vaan sen selvittämisessä, mikä on pienin mahdollinen mekanismi, jolla ihminen pystyy ohjaamaan tällaista yhteistyötä ilman, että koko prosessi pitää mallintaa etukäteen.

Tämä arvio perustuu lähdekoodin ja testien lukemiseen; en ajanut testejä enkä todentanut havaittuja reunatapauksia toimivassa ympäristössä.

## You

<!-- 2026-10-09T06:32:43.327Z -->

mun mielesät tää hiearkia kuka teke emitä ketjut piti jätätä vapaaksi

tätähän aloin pyrkimöän koska 

cli --user alice --channel #palala --message auttakaa tässä

pitäs saada hään tää ihmisten osusu

samoin jne

koska UI ei ole kiinnostva

se kok o homma pitäs saada näin

## ChatGPT

<!-- 2026-10-09T06:33:18.344Z -->

Ahaa, nyt tajusin! 😄 Ja mä olen itse asiassa yrittänyt työntää sun ajatusta väärään suuntaan ehdottamalla lisää mallinnettua vastuun siirtelyä.

**Sä haluat jättää itse yhteistyön vapaaksi. Et määritellä etukäteen, kuka kutsuu ketä, missä järjestyksessä ja millainen ketju siitä syntyy.**

Ja tuo CLI-esimerkki avasi ajatuksen paljon paremmin:

```bash
cli --user alice --channel '#palala' --message 'auttakaa tässä'
```

Tämä on oikeastaan koko käyttömalli.

Alice kirjoittaa yhteiseen tilaan. Agentit voivat reagoida, keskustella keskenään, pyytää toisiltaan apua ja kutsua ihmisiä mukaan. Alice voi tulla myöhemmin takaisin, korjata suuntaa, keskeyttää tekemisen tai tehdä päätöksen.

**Ihminen on osa samaa keskustelevaa ja toimivaa järjestelmää, ei erillinen hyväksyntäpalvelu agenttien ulkopuolella.**

## Eli Entropin ei tarvitse tietää yhteistyöketjua

<box border radius="xl" padding={3} gap={2}>
  <box background="surface-secondary" radius="lg" padding={3} gap={1}>
    <row align="center" justify="between">
      **#palala**
      <text color="tertiary" size="xs">Esimerkkitilanne</text>
    </row>
    <row gap={2} align="start">
      <box background="surface-tertiary" radius="full" padding={2}><icon name="user" size="sm"/></box>
      <box flex="1" gap={1}>
        <text weight="medium" size="xs">Alice</text>
        Auttakaa tässä, TR-korjaus ei taida riittää.
      </box>
    </row>
    <divider color="subtle"/>
    <row gap={2} align="start">
      <box background="surface-tertiary" radius="full" padding={2}><icon name="bot" size="sm"/></box>
      <box flex="1" gap={1}>
        <text weight="medium" size="xs">Ops</text>
        Tutkin tuotantovaikutukset. @developer, voisitko katsoa korjauksen laajuutta?
      </box>
    </row>
    <divider color="subtle"/>
    <row gap={2} align="start">
      <box background="surface-tertiary" radius="full" padding={2}><icon name="bot" size="sm"/></box>
      <box flex="1" gap={1}>
        <text weight="medium" size="xs">Developer</text>
        Löysin toisenkin riippuvuuden. Tässä on kolme mahdollista tapaa korjata asia.
      </box>
    </row>
    <divider color="subtle"/>
    <row gap={2} align="start">
      <box background="surface-tertiary" radius="full" padding={2}><icon name="user" size="sm"/></box>
      <box flex="1" gap={1}>
        <text weight="medium" size="xs">Alice</text>
        Ei tehdä vielä muutosta. Selvittäkää ensin, vaikuttaako se muihin palveluihin.
      </box>
    </row>
  </box>
  <caption>Yhteistyön kulkua ei ollut määritelty valmiiksi. Se muodostui keskustelun ja havaintojen perusteella.</caption>
</box>

Tässä ei tarvita mitään `Triage → Implement → Review` -workflow'ta.

Eikä edes agenttihierarkiaa teknisen suoritusjärjestyksen merkityksessä.

Tarvitaan vain yhteinen ympäristö, jossa tiedetään kuka puhuu, kuka toimii, mitä tapahtui ja mihin kullakin on valtuudet.

## Ja UI on silloin täysin epäolennainen ytimelle

Tämä oli mulle tärkeä korjaus sun selityksessä.

Sama järjestelmä voisi saada viestejä:

```bash
cli --user alice --channel '#palala' \
  --message 'auttakaa tässä'
```

Tai toisesta ohjelmasta HTTP API:n kautta, agentilta, terminaalista, Slack-sillasta tai mistä tahansa muusta käyttöpinnasta.

Mikään näistä ei saisi muuttaa sitä, mitä Entropissa tapahtuu.

**CLI, UI ja agentti ovat vain eri tapoja osallistua samaan ympäristöön.**

Ja itse asiassa nykyinen koodi on jo aika lähellä tätä ajatusta. `Core.postMessage()`, tapahtumaloki, actor-malli ja outbox ovat käyttöpinnasta riippumattomia.

Mutta yksi käytännön ero nykyiseen toteutukseen löytyy: tavallisessa kanavassa HTTP API herättää agentin tällä hetkellä ensisijaisesti `@maininnasta`. Ilman mainintaa viesti vain tallentuu. Kokeellinen FrontDesk-router pyrkii ratkaisemaan tätä, mutta se on oletuksena pois päältä.

Eli juuri tuo `auttakaa tässä` ilman ennalta nimettyä agenttia on edelleen kiinnostava kohta. Lisäksi tuotantokäytössä `--user alice` pitäisi sitoa varmennettuun identiteettiin, ettei kuka tahansa voi esiintyä Alicena.

## Tästä tulee mulle nyt erilainen tulkinta Entropista

Se ei ole ensisijaisesti AgentOS, joka organisoi agentit tiettyyn rakenteeseen.

Se on ennemmin **yhteinen toimintaympäristö itsenäisille ihmisille ja agenteille, jossa yhteistyön eteneminen on vapaa mutta valtuudet eivät ole.**

Tämä selittää myös sen, miksi pidät tiukasta coresta mutta et halua mallintaa vaikeiden ongelmien ratkaisuketjuja.

Ja minusta siinä on järkeä: Pi Durable hoitaa agentin jatkuvuuden, Entropi hoitaa yhteisen toimintatilan, ja yhteistyö saa syntyä orgaanisesti.

**Nyt kiinnostaa yksi asia:** haluaisitko, että agentit voivat itse seurata kanavaa ja päättää, milloin niillä on annettavaa, ilman että joku erikseen mainitsee tai kutsuu niitä?

Koska se olisi aika ratkaiseva ero nykyiseen viestistä käynnistyvään malliin — ja veisi Entropia lähemmäksi sitä alkuperäistä digitaalista tiimiä, jota lähdit rakentamaan.

## You

<!-- 2026-10-09T06:35:39.194Z -->

ja sitte cli --add-realm --config ja kaikki osapuolet se pitäs toimia multirealmissa kaikki roolit voi olla määritlety siitä kesjut kaikki

kaikki dynaamista

## ChatGPT

<!-- 2026-10-09T06:36:15.828Z -->

Ahaa! 😄 **Nyt mä ymmärrän, mitä tarkoitat sillä, että koko homman pitää olla dynaaminen.**

Ei pelkästään agenttien välinen yhteistyö, vaan **koko toimintaympäristön rakenne**.

Realmien, osallistujien, roolien, agenttien, työkalujen, oikeuksien ja keskustelutilojen pitäisi syntyä konfiguraatiosta ja muuttua ajon aikana.

Eikä mikään niistä saisi edellyttää uuden sovellusversion kirjoittamista.

## Eli käytännössä tällainen maailma

<box border radius="lg" padding={3} gap={2}>
  <text color="secondary" weight="medium" size="xs">ESIMERKKI HALUTUSTA CLI:STÄ — EI NYKYINEN TOTEUTUS</text>
  ```bash
  entropi realm add --config team.yaml

  entropi realm add --config production.yaml

  entropi send \
    --realm team \
    --channel palala \
    --message "auttakaa tässä"
  ```
</box>

Ja samalla ihmisellä tai agentilla voi olla eri asema eri realmeissa.

Esimerkiksi Alice voi olla yhden realmin ylläpitäjä, toisen realmin asiantuntija ja kolmannessa vain osallistuja. Sama koskee agentteja.

Eikä Entropin tarvitse tietää etukäteen, mitä *developer*, *reviewer*, *ops* tai *manager* tarkoittavat. Ne voivat olla kyseisen realmin määrittelemiä rooleja.

**Roolit eivät määrää keskusteluketjua. Ne määräävät osallistumisen ja toimivallan rajat.**

Tästä syntyy aika kiinnostava ero:

<box border radius="xl" padding={3} gap={2}>
  <box align="center" background="surface-secondary" radius="lg" padding={3} gap={1}>
    **Entropi core**
    <text size="xs" color="secondary" textAlign="center">Identiteetit, jäsenyydet, valtuudet, viestit, päätökset ja tapahtumat</text>
  </box>
  <grid columns={2} gap={2}>
    <grid-item>
      <box border radius="lg" padding={3} gap={1}>
        **Realm A**

        <text size="xs" color="secondary">Alice · Bob · Agentit X ja Y</text>
        <text size="xs" color="secondary">Omat roolit ja oikeudet</text>
      </box>
    </grid-item>
    <grid-item>
      <box border radius="lg" padding={3} gap={1}>
        **Realm B**

        <text size="xs" color="secondary">Alice · Carol · Agentit Y ja Z</text>
        <text size="xs" color="secondary">Eri roolit ja oikeudet</text>
      </box>
    </grid-item>
  </grid>
  <box align="center" gap={1}>
    <icon name="arrow-down-up" color="tertiary"/>
    <box background="surface-secondary" padding={3} radius="lg" width="100%" align="center" gap={1}>
      **CLI · HTTP · agenttiruntime · muut käyttöpinnat**
      <text size="xs" color="secondary" textAlign="center">Kaikki käyttävät samoja coren sääntöjä</text>
    </box>
  </box>
</box>

## Ja nykyisestä koodista löytyy kiinnostava ero tähän tavoitteeseen

Entropissa on jo `Core.createRealm()`, realm-kohtainen jäsenyys ja realm-rajattu tieto. Eli pohja on olemassa.

Mutta esimerkiksi:

- `createEntropi({ realm })` alustaa yhden oletusrealmin.
- HTTP:n kirjautumispolku liittää käyttäjän ensisijaisesti siihen oletusrealmiin.
- `viewer → operator → approver → admin` on vielä kiinteä roolihierarkia.
- Pi-runtime ja ulkoisten lähteiden käynnistys on koostettu yhden realmin ympärille.

Nämä eivät estä monirealmista järjestelmää, mutta tarkoittavat, ettei nykyinen toteutus ole vielä kokonaan dynaaminen.

Ja nyt ymmärrän paremmin, miksi sanoit, että UI on vain esimerkki. **Varsinainen tuote olisi coren ja sen rajapintojen muodostama toimintaympäristö.**

Silloin myös CLI on ensimmäisen luokan käyttöliittymä, eikä pelkkä ylläpitotyökalu.

## Tässä on mielestäni se tärkein arkkitehtoninen raja

Kaiken ei kuitenkaan tarvitse olla dynaamista.

**Dynaamista:** ketkä osallistuvat, millä rooleilla, missä realmeissa, millaisin valtuuksin ja millaisia yhteistyöketjuja muodostuu.

**Kiinteää:** identiteetti pitää todentaa, realmien tieto ei saa vuotaa, valtuuksia ei saa kiertää, päätökset pitää kirjata ja pysyvän työn pitää selvitä kaatumisista.

Tuossa on mielestäni erittäin johdonmukainen yhdistelmä: *vapaa yhteistyö tiukan ytimen sisällä*.

Ja nyt tajuan myös, miksi tämä lähti mielestäsi sopimaan ihan kaikkeen. Jos Entropi ei omista työnkulkuja eikä domainien rooleja, samalle ytimelle voi rakentaa aivan erilaisia yhteisöjä ja toimintaympäristöjä.

**Yksi asia nousi kuitenkin koodista erityisesti esiin:** nykyinen Entropi erottaa realmit toisistaan aika vahvasti. Olisi kiinnostavaa miettiä, miten sama agentti osallistuu useaan realmiin ilman, että yhden realmin yksityinen tieto päätyy sen toisen realmin keskustelumuistiin.

Se on varmaan yksi ensimmäisistä oikeasti vaikeista kysymyksistä, kun viet tätä täysin dynaamiseen suuntaan.

## You

<!-- 2026-10-09T08:10:26.728Z -->

jep ja testaus voidaan määritellä näin rakenetian

olis hauska sitten multi-realmikin

## ChatGPT

<!-- 2026-10-09T08:10:50.090Z -->

Jep! 😄 Ja nyt tästä tulee mun mielestä erityisen hauska testattava.

**Jos Entropi on oikeasti dynaaminen, testienkin pitäisi voida rakentaa kokonaisia maailmoja pelkästä konfiguraatiosta.** Ei niin, että testiin koodataan erikseen developer, reviewer, ops ja niiden yhteistyöketju.

Vaan testissä määritellään ympäristö ja katsotaan, mitä sen sisällä saa tapahtua.

Esimerkiksi tällainen voisi olla aika hieno integraatiotesti:

```bash
# Luodaan kaksi toisistaan riippumatonta ympäristöä
entropi realm add --config tests/development.yaml
entropi realm add --config tests/production.yaml

# Alice pyytää apua kehitysrealmissa
entropi send --realm development \
  --channel general \
  --message "Auttakaa selvittämään tämä bugi"

# Sama ihminen osallistuu toiseen realmiin
entropi send --realm production \
  --channel incidents \
  --message "Onko tämä sama ongelma tuotannossa?"
```

Tämä on siis ehdotus tavoitellusta CLI:stä, ei nykyisen koodin syntaksia.

Ja sitten testi ei välttämättä tarkista, *missä järjestyksessä agentit keskustelivat*. Se tarkistaa järjestelmän ominaisuudet:

- Alice voi olla `admin` kehitysrealmissa mutta `viewer` tuotannossa.
- Agentti voi kuulua molempiin realmeihin, mutta sen keskustelumuistit pysyvät erillään.
- Agentti ei voi käyttää kehitysrealmin valtuuksia tuotannossa.
- Kummankin realmin työt ja tapahtumat säilyvät prosessin kaatuessa.
- Ihminen voi puuttua yhteistyöhön ja pysäyttää toiminnan ilman etukäteen mallinnettua workflow'ta.

Tuo olisi oikeastaan paljon vahvempi testi Entropin idealle kuin valmiiksi käsikirjoitettu agenttidemo.

## Ja sitten se vielä kiinnostavampi multirealm 😁

Kuvittele, että toisessa realmissa on kehitystiimi ja toisessa tuotantotiimi.

Kehitystiimin agentti huomaa, että korjaus vaikuttaa tuotantoon.

Se ei saisi vain alkaa toimia tuotantorealmissa, vaikka olisi kuinka kyvykäs.

Mutta se voisi ehdottaa:

> Tämä havainto pitäisi välittää production-realmille. Saanko lähettää tämän rajatun yhteenvedon sinne?

Ihminen valtuuttaa tiedon siirron. Production-realmin toimijat päättävät itse, mitä sillä tekevät.

**Tuossa realmit olisivat itsenäisiä, mutta voisivat tehdä yhteistyötä hallitusti.**

Ja mikä parasta, edelleen ilman ennalta määrättyä työnkulkua.

Musta tässä voisi olla kaksi erillistä testitasoa: ensin todistetaan, että realmit ovat täysin eristettyjä; sitten todistetaan, että niiden välinen yhteistyö toimii vain eksplisiittisen valtuutuksen kautta.

Se olisi aika luonteva jatke sille tiukalle corelle, jonka olet jo rakentanut.

Ja ehkä kiinnostavin ajatus: **jos saat saman testikehikon luomaan mielivaltaisen määrän realmeja, ihmisiä, agentteja ja rooleja, alat samalla todistaa, ettei Entropin ydin oikeasti tunne mitään tiettyä organisaatiomallia.**

Se taitaa olla aika lähellä sitä, mitä olet hakenut alusta asti. 😄

## You

<!-- 2026-10-09T08:11:22.763Z -->

agentit eivät tarvise olla koknaan monessa realmissa, vaanriitätä että periateessa on joku silta-spokeperson sanoisin jotka muodosotavat oman tiiminsä

osittain voi olla virtuaalitiimeijäkin en tiedä

## ChatGPT

<!-- 2026-10-09T08:11:38.493Z -->

Aaaa, nyt! 😄 Mä ajattelin multirealmin liian kirjaimellisesti: että samat agentit pitäisi liittää useisiin realmeihin.

Mutta sä tarkoitat enemmän sitä, että **itsenäiset tiimit voisivat muodostaa keskenään yhteistyötä edustajiensa kautta**.

Ja tuo on oikeastaan paljon kiinnostavampi malli.

## Realmilla voisi olla oma spokesperson

<box border radius="xl" padding={3} gap={2}>
  <grid columns={2} gap={3}>
    <grid-item>
      <box border radius="lg" padding={3} gap={2}>
        <text weight="medium" textAlign="center">Development realm</text>
        <box background="surface-secondary" radius="md" padding={2} gap={1} align="center">
          <text size="xs">Developer · Reviewer</text>
          <text size="xs">Alice</text>
        </box>
        <row justify="center"><icon name="arrow-down" color="tertiary"/></row>
        <box background="rgba(40,120,200,0.09)" radius="md" padding={2} align="center">
          **Spokesperson A**
        </box>
      </box>
    </grid-item>
    <grid-item>
      <box border radius="lg" padding={3} gap={2}>
        <text weight="medium" textAlign="center">Production realm</text>
        <box background="surface-secondary" radius="md" padding={2} gap={1} align="center">
          <text size="xs">Ops · Analyst</text>
          <text size="xs">Bob</text>
        </box>
        <row justify="center"><icon name="arrow-down" color="tertiary"/></row>
        <box background="rgba(40,120,200,0.09)" radius="md" padding={2} align="center">
          **Spokesperson B**
        </box>
      </box>
    </grid-item>
  </grid>
  <row justify="center" align="center" gap={2}>
    <icon name="arrow-up-right" color="secondary"/>
    <box background="surface-secondary" radius="lg" padding={2}>
      <text weight="medium" size="sm">Valtuutettu yhteistyö</text>
    </box>
    <icon name="arrow-down-left" color="secondary"/>
  </row>
  <box border radius="lg" padding={3} align="center" gap={1}>
    **Mahdollinen virtuaalitiimi**
    <text color="secondary" size="xs" textAlign="center">Muodostuu tarpeen mukaan, voi hajota työn päätyttyä</text>
  </box>
</box>

Spokesperson ei välttämättä olisi mikään erityinen agenttityyppi. Se voisi olla aivan tavallinen agentti, jolle realm on antanut oikeuden edustaa itseään tietyissä asioissa.

Ja toisessa tilanteessa spokesperson voisi olla ihminen.

## Virtuaalitiimi on tässä hauska ajatus

Ajatellaan, että Development ja Production joutuvat selvittämään yhteistä ongelmaa.

Sen sijaan, että koko kummankin realmin agenttikokoonpano ja muistihistoria yhdistettäisiin, niiden edustajat voisivat muodostaa yhteisen, väliaikaisen keskustelutilan.

Siinä ne voisivat:

- Vaihtaa rajattua tietoa omista realmeistaan.
- Kysyä tarvittaessa apua oman realmin muilta jäseniltä.
- Neuvotella yhteisestä toimintatavasta.
- Viedä päätöstä vaativat asiat oikeille ihmisille.

Eikä Entropin tarvitsisi tietää etukäteen, millainen tiimi tästä muodostuu.

**Spokesperson ei siis ole ylempi agentti, vaan rajapinta kahden itsenäisen yhteisön välillä.**

Ja tähän liittyy yksi tosi tärkeä ero: kun spokesperson tietää jotain oman realminsa sisäisistä asioista, se ei tarkoita, että sillä olisi lupa kertoa kaikkea eteenpäin.

Eli sillan pitäisi kantaa mukanaan myös tiedon jakamisen ja toiminnan valtuudet.

## Mutta en mallintaisi virtuaalitiimiä vielä omaksi erityiseksi oliokseen

Tässä tulee mieleen se, mitä itse sanoit vaikeiden ongelmien turhasta mallintamisesta.

Saattaisit vahingossa rakentaa valtavan järjestelmän, jossa on `Team`, `VirtualTeam`, `Federation`, `Bridge`, `Spokesperson`, `Delegation` ja ties mitä.

Vaikka ehkä riittäisi:

**Realm + actor + space + valtuutettu viestinvälitys.**

Virtuaalitiimi syntyy käytännössä siitä, että joukko toimijoita osallistuu yhteiseen tekemiseen. Sen ei välttämättä tarvitse olla oma pysyvä rakenteensa.

Ja ehkä sama spokesperson voi yhdessä tilanteessa edustaa tiimiä ja toisessa olla vain tavallinen osallistuja.

Tästä mulle muodostuu nyt aika selkeä kuva siitä periaatteesta, jota tavoittelet:

**Entropin pitäisi mahdollistaa organisoituminen, ei määrätä organisaatiota.**

Se on paljon vapaampi ajatus kuin etukäteen määritellyt agenttiroolit ja työnkulkuketjut.

Ja nyt mä melkein kokeilisin koko multirealm-ajatusta yhdellä yksinkertaisella testillä: kaksi täysin erillistä realmia, kummassakin oma agenttitiimi, ja vain yksi sallittu silta niiden välillä. Katsotaan, pystyvätkö ne yhdessä ratkaisemaan ongelman ilman että niiden tarvitsee jakaa kaikkea muistia tai oikeuksia.

Jos se toimii, siinä olisi jo aika vahva demonstraatio Entropin varsinaisesta ideasta. 😄

## You

<!-- 2026-10-09T08:12:13.348Z -->

tää ei ole kiveen nakutettu, kuhan on todistettavissa ja simuloitavissa

## ChatGPT

<!-- 2026-10-09T08:12:19.849Z -->

Niinpä! 😄 Ja tämä on oikeastaan tärkeä tarkennus.

**Et halua lyödä arkkitehtuuria lukkoon ennen kuin tiedetään, miten se käyttäytyy. Haluat rakentaa mekanismeja, joiden ominaisuudet voidaan todistaa ja joiden yhteistoimintaa voidaan simuloida.**

Silloin spokesperson, virtuaalitiimi, hierarkia tai multirealm eivät ole vielä ratkaisuja. Ne ovat hypoteeseja.

Ja tämä sopii kiinnostavasti siihen, mitä Entropin koodissa on jo nyt: oikeusmatriisit, deterministinen demomaailma, failpointit, kaatumistestit ja tapahtumaloki.

Mä erottaisin kokeilussa kaksi asiaa:

**1. Asiat, jotka pitää voida todistaa täsmällisesti**

- Agentti ei voi ylittää sille myönnettyjä valtuuksia.
- Yhden realmin yksityinen tieto ei siirry toiseen ilman sallittua mekanismia.
- Sama delegointi tai hyväksytty toiminto ei toistu vahingossa palautumisen yhteydessä.
- Ihmisen kielteistä päätöstä ei voi kiertää vaihtamalla agenttia tai delegointiketjua.
- Työstä jää jälki, vaikka suorittava prosessi kaatuu.

Näitä voi testata ilman yhtäkään oikeaa kielimallia.

**2. Asiat, joita pitää simuloida ja mitata**

- Syntyykö yhteistyö ilman ennalta määriteltyä workflow'ta?
- Auttaako spokesperson vai hukkaako se olennaisen kontekstin?
- Milloin agentit alkavat delegoida toisilleen turhaan?
- Kuinka paljon ihminen joutuu puuttumaan tekemiseen?
- Löytääkö agenttien muodostama tiimi alkuperäiseen TR-ketjuun verrattuna laajemmat ja riittävät korjaukset?

Näissä ei ole yhtä universaalia oikeaa lopputulosta. Tarvitaan erilaisia tilanteita ja mittareita.

Ja tässä on mielestäni **hauskin mahdollinen suunta Entropille**:

Rakennetaan pieni simulaatio, jossa samalle ongelmalle kokeillaan eri toimintamalleja.

| Kokeilu | Rakenne |
|---|---|
| A | Kiinteä triage → implement → publish |
| B | Vapaa agenttien yhteistyö yhdessä realmissa |
| C | Kaksi realmia, rajattu spokesperson-silta |
| D | Tilanteen mukaan muodostuva väliaikainen tiimi |

Kaikille annetaan sama lähtötilanne ja samat käytettävissä olevat tiedot. Sitten verrataan, mitä ne löytävät, mitä ne jättävät huomaamatta, paljonko ne käyttävät resursseja ja miten ihminen pystyy ohjaamaan niitä.

Tässä pitäisi erottaa deterministiset simulaatiot ja oikeilla LLM:illä toistettavat kokeet. Edellisillä voidaan todentaa sääntöjä ja jälkimmäisillä arvioida käyttäytymistä, joka vaihtelee ajokertojen välillä.

**Ja mikä parasta: jos C osoittautuu huonommaksi kuin B, spokesperson-ideaa ei tarvitse puolustella. Sen voi jättää pois.**

Tämä muuttaa mun käsitystä projektista vielä kerran. Entropi ei välttämättä tarvitse seuraavaksi lisää ominaisuuksia.

Se voisi tarvita **simulaatioympäristön, jolla löydetään, mitä ominaisuuksia oikeasti kannattaa olla olemassa.**

Vähän kuin digitaalisten tiimien koealusta, jossa core pitää pelisäännöt muuttumattomina mutta organisoituminen jätetään kokeiltavaksi.

Ja tuossa olisi minusta aika kaunis jatkumo sun Temporal-kokeilulle: ei enää oleteta, että triage–implement–publish on oikea rakenne, vaan voidaan kokeellisesti selvittää, milloin se toimii ja milloin jokin vapaampi yhteistyömalli toimii paremmin.

## You

<!-- 2026-10-09T08:12:54.624Z -->

ja jollakin agentilla voi olla syvä muisti ne voi toimia ... siis ragin tai optchatin kautta todella isona

## ChatGPT

<!-- 2026-10-09T08:13:09.642Z -->

Aivan! 😄 Ja tuohan tekee tästä vielä kiinnostavamman.

**Agenttien ei tarvitse erota älykkyydeltään, mutta niiden käytettävissä oleva tieto ja muisti voivat erota valtavasti.**

Yksi agentti voi olla lähes muistiton suorittaja, toinen voi tuntea vuosien keskustelut ja kolmas voi hakea tietoa valtavasta dokumentti- ja tapahtuma-aineistosta.

Eikä kaikkien tarvitse kantaa samaa kontekstia.

## Tässä voisi olla kolme erilaista muistia

<box border radius="xl" padding={3} gap={2}>
  <box border radius="lg" padding={3} gap={1}>
    <row align="center" gap={2}>
      <icon name="messages-square" color="secondary"/>
      **OptChat — kokemuksellinen muisti**
    </row>
    <text size="sm" color="secondary">Mitä tässä keskustelussa on tapahtunut, mitä on kokeiltu ja miten tähän tilanteeseen päädyttiin. Vanha historia tiivistyy, mutta yksityiskohtiin voi palata.</text>
  </box>
  <box border radius="lg" padding={3} gap={1}>
    <row align="center" gap={2}>
      <icon name="database" color="secondary"/>
      **RAG — domainin tietämys**
    </row>
    <text size="sm" color="secondary">Koodi, dokumentaatio, tiketit, arkkitehtuuripäätökset, tuotantohistoria. Tietoa haetaan tarpeen mukaan sen sijaan, että kaikki olisi keskustelukontekstissa.</text>
  </box>
  <box border radius="lg" padding={3} gap={1}>
    <row align="center" gap={2}>
      <icon name="clipboard-check" color="secondary"/>
      **Entropi core — yhteiset tosiasiat**
    </row>
    <text size="sm" color="secondary">Kuka omistaa työn, mitä päätettiin, mitä odotetaan ja kenellä on valtuudet toimia. Näiden oikeellisuus ei saisi riippua mallin muistista.</text>
  </box>
</box>

Ja nyt alkaa näkyä yksi todella mielenkiintoinen mahdollisuus:

**Agentti voi toimia kokonaisen erikoisalan muistina muulle tiimille ilman, että sen tarvitsee johtaa muita agentteja.**

Esimerkiksi kehitystiimissä voisi olla agentti, jolla on pääsy vuosien arkkitehtuurihistoriaan ja aiempiin korjauksiin. Se ei välttämättä kirjoita koodia lainkaan. Mutta kun joku huomaa omituisen riippuvuuden, tämä agentti saattaa tunnistaa saman ongelman kahden vuoden takaa.

Se olisi juuri se tieto, joka alkuperäisessä TR-ketjussasi saattoi jäädä välittymättä.

## Nykyisessä Entropissa on jo osa tästä

Koodissa OptChat on sidottu Pi-keskusteluun, ja Pi-keskustelu puolestaan `(realm, space, agent)`-yhdistelmään.

Se tekee keskustelujen jatkuvuudesta hyvän lähtökohdan, mutta **yhden agentin laaja, useiden keskustelutilojen yli ulottuva domain-muisti ei vielä synny siitä automaattisesti**.

Lisäksi `consult` on tällä hetkellä tarkoituksella muistiton yksityinen apuri. `ask_agent` taas kutsuu varsinaista pitkäikäistä agenttia.

Tästä ei ehkä tarvitsisi rakentaa mitään uutta agenttihierarkiaa. Voisi vain antaa tietyille agenteille erilaisia muistilähteitä ja oikeuksia käyttää niitä.

## Ja tämä olisi todella hyvä simulaatiokohde

Pidetään samat agenttimallit ja sama ongelma, mutta vaihdetaan vain muistirakennetta:

| Kokeilu | Muistin rakenne |
|---|---|
| A | Jokaisella vain oma keskustelumuisti |
| B | Yhdellä agentilla suuri OptChat-historia |
| C | Yhdellä agentilla domain-RAG |
| D | Yhteistyö, jossa agentit hakevat tietoa toisiltaan |
| E | Usean realmin yhteistyö rajattujen muistirajapintojen kautta |

Sitten mitataan, löytyykö oikea ratkaisu, kuinka paljon kontekstia katoaa ja paljonko se maksaa.

Tässä olisi myös syytä testata, ettei syvä muisti muutu automaattisesti suureksi *toimivallaksi*. Agentti voi tietää erittäin paljon, mutta sillä ei silti välttämättä ole oikeutta tehdä muutoksia tai jakaa kaikkea tietämäänsä toiseen realmiin.

**Mulle alkaa muodostua tästä yksi aika hauska ajatus: Entropissa agentin koko ei välttämättä määräydy mallin koon perusteella, vaan sen muistin, tietolähteiden ja kokemushistorian perusteella.**

Pieni paikallinen malli voisi olla todella hyödyllinen asiantuntija, jos sen ympärillä on oikea tietämys ja se osaa hakea siitä olennaisen.

Ja silloin se alkuperäinen ajatus digitaalisesta tiimistä alkaa näyttää aivan erilaiselta: tiimin kollektiivinen osaaminen ei ole yhdessä valtavassa promptissa, vaan jakaantuu toimijoiden ja tietolähteiden kesken.

**Tuota mä lähtisin kokeilemaan ennen kuin päättäisin, millaisia tiimejä tai hierarkioita Entropissa edes pitäisi olla.**

## You

<!-- 2026-10-09T08:14:34.634Z -->

tee suunitelma mihin tätä pitäs kehittää tässä vaiheessa

## ChatGPT

<!-- 2026-10-09T08:14:46.486Z -->

Teen tästä kehityssuunnitelman nykyisen Entropin pohjalta, en yleistä AgentOS-roadmapia. Priorisoin ensin sen, mikä todistaa ideasi pienimmällä muutoksella: CLI ensisijaisena käyttöliittymänä, dynaamiset realmit, vapaa yhteistyö sekä todennettavat oikeus- ja muistirajat. Tarkistan samalla, mitä koodissa jo on, jotta suunnitelma ei ehdota rakentamaan samoja asioita uudestaan.

## ChatGPT

<!-- 2026-10-09T08:15:27.778Z -->

Mä kehittäisin Entropia tässä vaiheessa **koealustaksi, jossa ihmiset ja agentit voivat organisoitua vapaasti, mutta yhteistyön turvallisuus, jatkuvuus ja tulokset ovat testattavissa**.

En rakentaisi vielä valmista AgentOS:ää, virtuaalitiimihierarkiaa tai spokesperson-järjestelmää. Ne ovat kiinnostavia kokeiltavia malleja, mutta niiden toimivuutta ei ole vielä osoitettu.

Kävin koodia uudelleen läpi. Hyvä uutinen on, että pohjasta löytyy jo iso osa tarvittavista mekanismeista: realm-rajattu core, Pi Durable, pysyvä viestinvälitys, hyväksynnät, OptChat, adapterirajat sekä deterministiset ja oikeita prosessikaatumisia testaavat testit.

**Tärkein seuraava askel ei mielestäni ole lisätä agenttien älykkyyttä. Se on tehdä nykyisestä ytimestä täysin ohjattava ilman demo-UI:ta ja rakentaa sen päälle simulaatiot, joilla omat ideasi voidaan haastaa.**

Tavoitteeksi asettaisin ensimmäiselle kehityskierrokselle tämän:

> Yhdestä konfiguraatiosta voidaan luoda kaksi erilaista realmia, käynnistää niihin ihmiset ja agentit, keskustella CLI:llä, muuttaa osallistujien oikeuksia, simuloida yhteistyötä ja todentaa, ettei tieto tai toimivalta vuoda rajojen yli.

Alla on toteutusjärjestys, jolla pääsisin siihen mahdollisimman pienellä uudella koodimäärällä.

<WritingBlock id="58321" variant="document"># Entropi — kehityssuunnitelma v0.2

**Tavoite:** tehdä Entropista dynaaminen, CLI-ohjattava ja simuloitava ympäristö, jossa ihmiset ja agentit voivat muodostaa yhteistyötä ilman ennalta määrättyjä työnkulkuja.

**Periaate:** core määrää, mikä on sallittua ja mitä tapahtui. Agentit ja ihmiset päättävät, miten ongelmia ratkaistaan.

**Kehitysjärjestys:** ensin todistettavuus ja käyttöpinnat, sitten muisti ja yhteistyökokeilut, lopuksi multirealm.

---

## P0 — Varmista nykyisen ytimen lupaukset

**Prioriteetti: korkein.** Ei uusia isoja ominaisuuksia.

Ennen arkkitehtuurin laajentamista korjataan kohdat, joissa konfiguroidut vastuut ja tekniset oikeudet saattavat erota toisistaan.

### Toteutettavat asiat

- Erotetaan agenttien roolikuvaukset ja oikeasti sallitut työkalut toisistaan.
- Varmistetaan, ettei read-only-agentti saa kirjoitustyökaluja vain yhteisen `coding-tools`-laajennuksen vuoksi.
- Määritellään, milloin saman realmin tai tilan agentit voivat jakaa sandboxin.
- Testataan hyväksynnät tilanteessa, jossa työn omistaja ei itse saa hyväksyä toimintoa ja hyväksyjä ei näe yksityistä tilaa.
- Varmistetaan, että ulkoisten toimintojen valtuutukset tarkistetaan toiminnon suoritusrajalla, ei vain promptissa.
- Säilytetään nykyiset crash-, concurrency- ja oikeusmatriisitestit.

### Valmistumiskriteeri

Konfiguroituja oikeuksia ei voi kiertää agentin promptilla, toisella työkalulla tai delegoinnilla. Kaatumisesta palautuminen säilyy ennallaan.

**Mitä ei tehdä:** ei rakenneta vielä yleiskäyttöistä policy-kieltä tai monimutkaista RBAC-frameworkia.

## P1 — CLI ja dynaamiset realmit

**Tämä on ensimmäinen varsinainen tuoteominaisuus.**

Entropin pitää toimia ilman demo-UI:ta.

### CLI:n peruskomennot

- `realm list`, `realm apply`, `realm inspect`
- `actor list`, `actor grant`, `actor revoke`
- `space list`, `space create`
- `message send`, `message watch`
- `decision list`, `decision decide`
- `agent stop`, `agent inspect`
- `events tail`

CLI on ohut asiakas samalle API:lle, jota muutkin käyttävät. Sille ei rakenneta omaa etuoikeutettua reittiä coreen.

Käyttäjäidentiteetti tulee todennetusta istunnosta tai tunnisteesta; `--user alice` voi toimia testiajossa, mutta tuotantoympäristössä sillä ei saa pystyä esiintymään toisena ihmisenä.

### Konfiguraatio

Realm voidaan määritellä tiedostolla, jossa on:

- Realmin tunniste ja toimintapolitiikka
- Ihmiset ja agentit
- Roolit ja valtuudet
- Kanavat ja osallistujat
- Agenttien käyttämät mallit, työkalut ja muistilähteet
- Mahdolliset ulkoiset järjestelmät

`realm apply` vertailee tavoitetilaa nykyiseen ja toteuttaa sallitut muutokset. Vaaralliset poistot ja oikeuksien laajennukset ovat erikseen vahvistettavia.

Nykyinen `seedRealm()` on hyvä lähtökohta, mutta sitä pitää laajentaa: uuden realmin luominen ei riitä, myös jo olemassa olevan realmin muutosten on toimittava.

### Valmistumiskriteeri

Käynnissä olevaan Entropiin voidaan lisätä uusi realm, agentti tai kanava ja muuttaa valtuuksia ilman sovelluskoodin muuttamista.

## P2 — Simulaatiokehikko

**Tämä on projektin tärkein tutkimuksellinen osa.**

Tehdään `entropi simulate`, joka luo testimaailman konfiguraatiosta, ajaa tapahtumat ja palauttaa jäljitettävän tuloksen.

### Simulaation ominaisuudet

- Deterministinen kello ja satunnaissiementen hallinta
- Scriptatut agentit ja ulkoiset valejärjestelmät
- Vaihdettavat aidot LLM-agentit erillisiä kokeita varten
- Vikatilanteiden injektointi: kaatumiset, viiveet, puuttuva tieto, väärät vastaukset
- Koko tapahtumaketjun tallennus ja uudelleenajo
- Automaattisesti tarkistettavat turvallisuusinvariantit

Ensimmäiset neljä skenaariota:

| Skenaario | Mitä todistetaan tai mitataan |
|---|---|
| Vapaa yhteistyö | Agentit ratkaisevat ongelmaa ilman kiinteää workflow'ta |
| Puuttuva TR-konteksti | Huomaako tiimi, että ehdotettu minimikorjaus ei riitä? |
| Ihmisen väliintulo | Ihminen voi muuttaa suuntaa, hylätä ja pysäyttää työn |
| Kaatuminen kesken delegoinnin | Työt säilyvät, eikä samoja toimintoja tehdä kahdesti |

### Mittarit

- Ratkaisun oikeellisuus ja kattavuus
- Huomaamatta jääneet riippuvuudet
- Delegointien ja turhien kierrosten määrä
- Ihmisen päätöspisteiden määrä
- Token- ja suorituskustannukset
- Kadonneet työt, toistuneet sivuvaikutukset ja oikeusrikkomukset

Turvallisuusominaisuudet voidaan todentaa deterministisillä testeillä. LLM-yhteistyön laatua arvioidaan toistuvilla kokeilla, ei yhdellä onnistuneella demolla.

### Valmistumiskriteeri

Yksi komento ajaa skenaarion ja tuottaa raportin, josta näkyvät tapahtumat, päätökset, rikotut invariantit ja lopputulos.

## P3 — Muistista vaihdettava kyvykkyys

**Ei yhtä universaalia muistia kaikille agenteille.**

Agentin muisti määritellään osaksi sen kokoonpanoa. Eri agentit voivat käyttää eri muistiratkaisuja ilman että core tietää niiden toteutuksesta.

### Kokeiltavat muistimallit

1. **Session-muisti:** vain tämänhetkinen Pi-keskustelu.
2. **OptChat:** pitkä keskusteluhistoria, tiivistykset ja `memory_zoom`.
3. **Domain-RAG:** dokumentit, koodi, tiketit ja tapahtumahistoria.
4. **Yhdistelmä:** OptChat kokemushistoriana, RAG tietolähteenä.

Muistille tarvitaan rajapinta, jolla on selkeä realm-kohtainen käyttöoikeus. Haun tuloksessa pitäisi säilyä lähde ja alkuperä, jotta agentti voi perustella väitteensä.

### Tärkeä koe

Sama ongelma annetaan kolmelle saman mallin agentille:

- A: ei pitkäaikaista muistia
- B: OptChat
- C: OptChat + domain-RAG

Mitataan, mikä löytää riittävän ratkaisun ja paljonko se maksaa.

### Valmistumiskriteeri

Muistiratkaisun voi vaihtaa konfiguraatiolla. Yhden realmin tieto ei päädy toisen realmin hakuun ilman nimenomaista valtuutusta.

## P4 — Multirealm ja kokeelliset sillat

**Multirealm kyllä, mutta ei vielä kiinteää spokesperson-arkkitehtuuria.**

Ensin tehdään kaksi erillistä realmia ja osoitetaan, että ne toimivat samanaikaisesti yhden Entropi-instanssin sisällä.

Sen jälkeen kokeillaan eri tapoja välittää tietoa realmien välillä.

### Ensimmäiset kokeet

**A. Täysi eristys**

Kahden realmin toimijat eivät näe toistensa viestejä, muistia, töitä tai päätöksiä.

**B. Valtuutettu viestinvälitys**

Realmin valtuutettu osallistuja voi lähettää rajatun viestin toiseen realmiin. Siirrosta jää tapahtuma.

**C. Spokesperson**

Realm valitsee edustajan, joka kommunikoi toisen realmin edustajan kanssa ja voi palata oman tiiminsä puoleen.

**D. Väliaikainen virtuaalitiimi**

Yhteisen ongelman ympärille muodostetaan väliaikainen yhteistyötila.

Näistä B, C ja D ovat keskenään kilpailevia kokeita. Niitä ei tarvitse kaikkia vakiinnuttaa osaksi corea.

### Valmistumiskriteeri

Kaksi realmia pystyy ratkaisemaan yhteisen ongelman hallitusti, ilman yhteistä muistia tai jaettua yleisvaltuutta.

## P5 — Paluu alkuperäiseen TR-ongelmaan

Tämän kierroksen lopullinen koe kannattaa tehdä sillä ongelmalla, josta Entropin ajatus syntyi.

Verrataan samaa realistista TR-tapausta seuraavilla malleilla:

1. Alkuperäinen Temporal Triage → Implement → Publish
2. Entropi, vapaa agenttiyhteistyö
3. Entropi, mukana syvän domain-muistin agentti
4. Entropi, mahdollisesti usean realmin yhteistyö

Erityisen tärkeä tulos ei ole vain se, onnistuuko korjaus.

**Oleellinen kysymys on, huomaako järjestelmä, että alkuperäinen korjausehdotus on riittämätön.**

Jos Entropi pystyy ratkaisemaan tämän ongelman pienemmällä tai yhtä suurella kustannuksella ilman ennalta mallinnettua työnkulkua, se on vahvaa näyttöä koko ajatuksen puolesta.

---

## Mitä ei kannata tehdä vielä

- Uusi iso UI tai dashboard
- Oma workflow-kieli
- Kiinteä agenttihierarkia
- Yleinen virtuaalitiimi- tai spokesperson-entiteetti coressa
- Agenttien globaali yhteismuisti
- Hajautettu monisolmuinen core tai uusi Temporal-integraatio
- RAG:n tai vektorikannan rakentaminen itse
- Kymmenet tuotantoadapterit ennen kuin toimintamalli on osoitettu hyödylliseksi

Näihin voi palata, jos simulaatiot osoittavat niille tarpeen.

---

## Ensimmäinen toteutettava kokonaisuus

**Milestone: Entropi Headless Lab**

Tämä on rajattu tavoite, jolla olisi mielestäni eniten arvoa juuri nyt.

- [ ] Toimiva CLI HTTP API:n päällä
- [ ] Kahden realmin konfiguraatio ja luonti
- [ ] Agenttien, roolien ja kanavien muutokset konfiguraatiosta
- [ ] Oikeuksien tekninen pakottaminen myös työkaluissa
- [ ] Viestien lähetys, seuraaminen ja ihmisen päätökset CLI:stä
- [ ] Deterministinen monirealm-simulaatio
- [ ] Automaattinen raportti sekä oikeus- ja eristystestit

**Määritelmä valmiille:** kahteen erilaiseen realmiin voi luoda toimijat konfiguraatiosta, käynnistää yhteistyön CLI:llä, muuttaa valtuuksia ajon aikana ja osoittaa testeillä, että toiminta noudattaa sääntöjä myös kaatumisen yhteydessä.

Vasta tämän jälkeen lisäisin muisti- ja yhteistyömallien vertailut.

---

## Pitkän aikavälin suunnittelusääntö

Jokaisen uuden Entropi-ominaisuuden pitäisi vastata kolmeen kysymykseen:

1. Mitä uutta käyttäytymistä se mahdollistaa?
2. Voiko saman asian toteuttaa nykyisillä mekanismeilla tai adapterilla?
3. Millä simulaatiolla tai testillä voidaan osoittaa, että lisäys on hyödyllinen ja turvallinen?

Jos kolmatta kysymystä ei osata vielä vastata, ominaisuutta ei tarvitse rakentaa.

**Entropin coren ei pitäisi kasvaa sen perusteella, kuinka monimutkaisia organisaatioita voimme kuvitella. Sen pitäisi kasvaa vain silloin, kun kokeet osoittavat, että nykyisistä mekanismeista puuttuu jotain olennaista.**</WritingBlock>

## Mistä aloittaisin koodissa?

Ensimmäiset muutokset kohdistaisin näihin nykyisiin osiin:

| Tiedosto | Kehitystehtävä |
|---|---|
| [src/entropi.ts](https://github.com/taituo/entropi/blob/master/src/entropi.ts) | Yhden käynnistysrealmin oletuksesta usean realmin hallintaan |
| [src/seed.ts](https://github.com/taituo/entropi/blob/master/src/seed.ts) | Alustuksesta konfiguraation muutosten hallittuun sovittamiseen |
| [src/http/api.ts](https://github.com/taituo/entropi/blob/master/src/http/api.ts) | Realmien ja jäsenyyksien hallinta API:n kautta |
| [src/adapters/router/router.ts](https://github.com/taituo/entropi/blob/master/src/adapters/router/router.ts) | Kiinteiden demoagenttien sijaan realmin kokoonpanosta saatavat osallistujat |
| [test/](https://github.com/taituo/entropi/tree/master/test) | Simulaatioajuri nykyisten oikeus-, concurrency- ja crash-testien rinnalle |

Yksi tärkeä tarkennus vielä: **en lähtisi heti kirjoittamaan suurta uutta simulaattoria**. Entropilla on jo `FakeWorld`, scriptatut agentit, tapahtumaloki, kelloon perustuvia testejä ja failpointit. Rakentaisin niiden päälle ohuen skenaarioajurin.

Näin seuraava kehitysvaihe voisi pysyä yllättävän pienenä, vaikka sillä testattaisiin varsin suurta ajatusta.

Mun valinta olisi siis: **CLI + dynaaminen multirealm-perusta + simulaatioajuri ensin.** Sen jälkeen OptChat/RAG-agentit ja spokesperson-mallit kilpailemaan kokeissa siitä, tuovatko ne oikeasti lisäarvoa.

## You

<!-- 2026-10-09T08:18:12.766Z -->

pitäs ajalla että voisint recursisiivesti ajaa eri simulaatiota ja oikeaita tehtäviä .. CLI sijasta voi olla oikea sopivampi protokolla, cli oli vaan idea onko jotain protokollaa olemassa? onko kukaan thenhyt?.. halausin kehittää sellasien, myös ihmisen liittäminen keskuslteuihinok

olisko stack valmisj o rekursisiiviesti kehittämään itseään? ymmärätkö ne deployaisivat isestään uuden version muisti säilyisi yli?

täysin unattended, oma realmi ylläpitoon

## ChatGPT

<!-- 2026-10-09T08:18:28.994Z -->

Ymmärrän: et hae vain agenttien välistä chattia, vaan ympäristöä, jossa agentit voivat käynnistää uusia kokeita, tehdä oikeita kehitystehtäviä, arvioida tuloksia ja lopulta päivittää jopa Entropin itsensä — niin että ihmisen voi kutsua samaan keskusteluun tarvittaessa. Tutkin tähän olemassa olevat protokollat ja vertaan niitä nykyiseen koodiin. Erityisesti erotan sen, mikä olisi jo mahdollista, siitä mikä pitää varmistaa ennen täysin unattended-itsekehitystä.

## ChatGPT

<!-- 2026-10-09T08:19:33.447Z -->

Protokollapuolelta löytyi yksi selvä ero: A2A soveltuu itsenäisten agenttijärjestelmien väliseen työnsiirtoon, mutta ihmisten ja agenttien yhteinen, jatkuva keskustelutila muistuttaa enemmän Matrixia. Itsepäivityksessä vaikein kohta ei taas ole koodin kirjoittaminen, vaan se, että vanha ja uusi versio jakavat pysyvän tilan turvallisesti ja että päivityksen hyväksyvä mekanismi säilyy agenttien muutosten ulkopuolella. Tarkistan vielä Entropin nykyisen tallennus- ja käynnistysrakenteen tätä vasten.

## ChatGPT

<!-- 2026-10-09T08:19:07.657Z -->

**Joo, ymmärrän. Ja tämä on selvästi seuraava taso Entropille.** 😄

Et halua vain järjestelmää, jossa agentit ratkaisevat tehtäviä. Haluat järjestelmän, jossa ne voivat myös:

- luoda uusia tiimejä ja simulaatioympäristöjä
- kokeilla vaihtoehtoisia ratkaisuja rinnakkain
- arvioida kokeiden tuloksia ja muuttaa omaa toimintatapaansa
- tehdä oikeita kehitystehtäviä
- rakentaa ja julkaista uuden version Entropista
- jatkaa toimintaansa uuden version käynnistyttyä, aikaisempi muisti säilyttäen

Ja ihminen voi liittyä keskusteluun, muuttaa suuntaa tai antaa päätöksen, mutta hänen ei tarvitse ohjata jokaista vaihetta.

**Tämä on teknisesti mahdollinen tavoite. Nykyinen Entropi ei kuitenkaan vielä ole valmis turvalliseen, täysin unattended-itsepäivitykseen.** Se on jo hyvä pohja kokeilulle.

## Onko tähän jo protokollia?

On. Et ole ensimmäinen, joka rakentaa näitä osia, mutta eri standardit ratkaisevat eri ongelmia.

| Protokolla | Mitä se ratkaisee | Sopivuus Entropiin |
|---|---|---|
| <Entity category="software" value="Matrix" disambig="Avoin hajautettu viestintäprotokolla"/> | Pysyvät keskusteluhuoneet, ihmiset, botit ja organisaatiorajat | **Erittäin kiinnostava** ihmisten ja agenttien yhteisiin keskusteluihin |
| <Entity category="software" value="Agent2Agent (A2A)" disambig="Agenttien välinen yhteentoimivuusprotokolla"/> | Agenttijärjestelmien väliset tehtävät, viestit ja tulokset | Mahdolliset realmien väliset sillat |
| <Entity category="software" value="Model Context Protocol (MCP)" disambig="Työkalujen ja tietolähteiden integrointiprotokolla"/> | Työkalut, tietolähteet ja toimintojen kutsuminen | RAG, GitHub, testit, deploy-työkalut |
| <Entity category="software" value="Agent Client Protocol (ACP)" disambig="Zedin agentti-editori-yhteysprotokolla"/> | Koodausagenttien käyttäminen riippumattomista asiakkaista | Aiemmat ACP:n yli käyttämäsi koodaus-CLI:t |
| <Entity category="software" value="AG-UI" disambig="Agentin ja käyttöliittymän välinen tapahtumaprotokolla"/> | Agentin streaming, ihmisen väliintulot ja hyväksynnät | Jos joskus haluat ulkoisia käyttöliittymiä |

A2A:ssa on jo monivuoroiset tehtävät ja `input-required`-tila, jossa agentti voi pyytää lisätietoa. Matrix taas on avoin, pysyviä huoneita ja tapahtumia tukeva viestintäjärjestelmä, johon voi liittää botteja Application Service -rajapinnan avulla. <Cite refs={["turn241118search11","turn482756search1","turn482756search0","turn482756search8","turn482756search7","turn701164search1"]}/>

**Mun ensimmäinen protokollakokeilu olisi Matrix-adapteri Entropiin.** Ei Matrixia coren tilalle, vaan yhtenä käyttöpintana.

Silloin oikea ihminen voisi käyttää esimerkiksi tavallista Matrix-asiakasta, agentit voisivat osallistua huoneisiin ja Entropi vastaisi edelleen valtuuksista, töistä, päätöksistä ja auditoinnista.

A2A kannattaa lisätä vasta, kun tarvitset yhteyden itsenäisiin agenttijärjestelmiin tai eri Entropi-instansseihin. Se ei yksinään korvaa yhteistä monen osallistujan keskusteluhuonetta.

## Onko kukaan tehnyt rekursiivista itsekehitystä?

Kyllä, ainakin rajatummissa muodoissa.

**<Entity category="software" value="autoresearch" disambig="Andrej Karpathyn autonomisten ML-kokeiden GitHub-projekti"/>** on hyvä esimerkki. Siinä agentti muuttaa koodia, ajaa kokeen, mittaa tuloksen, säilyttää parannuksen tai hylkää muutoksen ja aloittaa uuden kierroksen. Se on juuri kuvaamasi rekursiivisen kokeilun perusmekanismi, mutta rajattuna koneoppimisen tutkimustehtävään. <Cite refs={["turn241118search2"]}/>

**<Entity category="software" value="OpenHands" disambig="Avoimen lähdekoodin ohjelmistokehitysagenttialusta"/>** puolestaan tarjoaa koodausagentteja, sandboxeja, keskusteluja ja etäohjattavia suoritusympäristöjä. Sen SDK tukee myös ACP:n kautta käytettäviä koodausagentteja. Se on lähempänä varsinaista autonomista ohjelmistokehitystä. <Cite refs={["turn701164search10","turn701164search18"]}/>

Ja automaattinen julkaiseminen sekä palautuminen eivät vaadi uutta agenttiteknologiaa. Esimerkiksi <Entity category="software" value="Argo Rollouts" disambig="Kubernetesin progressiivisen julkaisun controller"/> osaa tehdä canary-julkaisuja, mittareihin perustuvaa analyysiä ja automaattisia rollbackeja. <Cite refs={["turn241118search1","turn241118search4"]}/>

Mutta Entropin kiinnostava erityispiirre olisi yhdistää nämä **samaan ihmisten ja agenttien toimintaympäristöön**: agentit voisivat itse perustaa uuden kokeilun, muodostaa siihen tiimin, käyttää pitkäaikaista muistia ja ehdottaa tai toteuttaa seuraavan version.

En kuitenkaan väittäisi, ettei kukaan muu olisi tehnyt näin. Näistä lähteistä ei käy ilmi, että jokin valmis järjestelmä kattaisi täsmälleen kaikki kuvaamasi ominaisuudet.

## Olisiko nykyinen Entropi valmis päivittämään itsensä?

<box gap={2}>
  <row align="start" gap={3}>
    <icon name="check-circle-2" color="success" size="lg"/>
    <box flex="1" gap={1}>
      **Agentin suorituksen jatkuvuus: hyvä pohja**

      Pi Durable pitää keskustelujen ja tehtävien tilaa pysyvässä tallennuksessa. Entropin dispatch, outbox ja crash-testit tukevat palautumista.
    </box>
  </row>
  <divider color="subtle"/>
  <row align="start" gap={3}>
    <icon name="check-circle-2" color="success" size="lg"/>
    <box flex="1" gap={1}>
      **Muistin säilyminen versionvaihdossa: periaatteessa mahdollista**

      `entropi.sqlite`, `pi.sqlite` ja `memory.sqlite` ovat erillisiä pysyviä tiedostoja. OptChat on johdettavissa uudelleen Pi-transkripteista.
    </box>
  </row>
  <divider color="subtle"/>
  <row align="start" gap={3}>
    <icon name="alert-triangle" color="secondary" size="lg"/>
    <box flex="1" gap={1}>
      **Automaattinen julkaisu: ei vielä valmiina**

      Koodissa ei vielä ole yleistä koodimuutos → build → evaluointi → julkaisu → rollback -ketjua. Oikeita kehitys-, CI- ja deploy-adaptereitakin puuttuu.
    </box>
  </row>
  <divider color="subtle"/>
  <row align="start" gap={3}>
    <icon name="alert-triangle" color="secondary" size="lg"/>
    <box flex="1" gap={1}>
      **Turvallinen itsepäivitys: puuttuu olennainen suojarakenne**

      Käynnistyksessä suoritetaan tietokantamigraatioita, mutta varmuuskopioita, yhteensopivuustarkistuksia tai migraatioiden rollbackia ei vielä ole. Uusi versio voisi tehdä vanhasta tallennustilasta lukukelvottoman.
    </box>
  </row>
</box>

Lähdekoodin olennaiset kohdat: [entropi.ts](https://github.com/taituo/entropi/blob/master/src/entropi.ts), [db.ts](https://github.com/taituo/entropi/blob/master/src/core/db.ts) ja [with-batteries.md](https://github.com/taituo/entropi/blob/master/docs/with-batteries.md).

**Pelkkä konttien uudelleenkäynnistys saman datavolyymin kanssa on eri asia kuin uuden, itsensä muuttaneen version turvallinen käyttöönotto.** Ensimmäiseen nykyinen arkkitehtuuri antaa pohjan. Jälkimmäinen tarvitsee vielä oman mekanisminsa.

## Miten rakentaisin itseään kehittävän Entropin?

Erotan tähän kaksi asiaa: **itseään kehittävän ympäristön** ja **sen toimintaa valvovan ympäristön**.

<box border radius="xl" padding={3} gap={2}>
  <box border radius="lg" padding={3} gap={1}>
    <row align="center" gap={2}>
      <icon name="shield-check" color="secondary"/>
      **Suojattu ylläpitokerros**
    </row>
    <text color="secondary" size="xs">Julkaisuoikeudet, budjettirajat, varmuuskopiot, evaluointisäännöt ja automaattinen palautuminen. Agentit eivät voi itse poistaa näitä rajoja.</text>
  </box>
  <row justify="center"><icon name="arrow-down-up" color="tertiary"/></row>
  <box background="surface-secondary" radius="lg" padding={3} gap={1}>
    **Realm: entropi-maintenance**

    <text size="sm">Pitkäikäiset agentit tutkivat ongelmia, tekevät koodimuutoksia, käynnistävät kokeita ja keskustelevat niistä. Ihminen voi liittyä samaan tilaan.</text>
  </box>
  <row justify="center"><icon name="arrow-down-up" color="tertiary"/></row>
  <grid columns={2} gap={2}>
    <grid-item>
      <box border radius="lg" padding={3} gap={1}>
        **Simulation realms**

        <text color="secondary" size="xs">Rinnakkaiset ja sisäkkäiset kokeilut, eri tiimirakenteet, muistimallit ja konfiguraatiot</text>
      </box>
    </grid-item>
    <grid-item>
      <box border radius="lg" padding={3} gap={1}>
        **Candidate environments**

        <text color="secondary" size="xs">Uudet koodiversiot, todelliset integraatiotestit, staging ja canary</text>
      </box>
    </grid-item>
  </grid>
  <row justify="center"><icon name="arrow-down" color="tertiary"/></row>
  <box border radius="lg" padding={3} gap={1}>
    **Stable Entropi**

    <text color="secondary" size="xs">Nykyinen toimiva versio säilyy käytössä, kunnes uusi versio on hyväksynyt riippumattomat testit ja käyttöönoton ehdot.</text>
  </box>
</box>

Ylläpitorealmin ei tarvitse olla erityinen agenttilaji. Se on tavallinen realm, jolla on tavallisista realmeista eroavat valtuudet.

Mutta **ylläpitorealmin ja varsinaisen julkaisukontrollerin ei kannata olla sama asia**.

Miksi? Koska kun agentit rikkovat Entropin päivityksellä, niiden oman ylläpitorealmin keskustelutkin voivat lakata toimimasta. Jonkin itsenäisen komponentin on pystyttävä palauttamaan edellinen versio ilman apua rikkoutuneelta Entropilta.

## Rekursiiviset simulaatiot voisivat olla ensimmäinen oikea ominaisuus

Kuvitellaan tällainen kierros:

<CodeBlock language="text">maintenance realm
  |
  |-- havaitsee: nykyinen delegointi hukkaa kontekstia
  |
  |-- luo experiment-101
  |      |-- kokeilee OptChat-muistia
  |      |-- kokeilee RAG-muistia
  |      `-- vertaa tuloksia
  |
  |-- luo experiment-102
  |      |-- kokeilee erilaista agenttien yhteistyötä
  |      `-- luo tarvittaessa omat alikokeensa
  |
  |-- arvioi tulokset
  |-- ehdottaa koodimuutosta
  |-- rakentaa uuden Entropi-version
  |-- ajaa riippumattoman testipaketin
  |-- julkaisee eristettyyn canary-ympäristöön
  |
  `-- säilyttää tai hylkää uuden version</CodeBlock>

Tässä agenttien ei tarvitse tietää etukäteen kokeiluketjua. Ne voivat muodostaa uusia kokeita havaintojensa perusteella.

Mutta suoritusjärjestelmän pitää asettaa rekursiolle **budjetti, aikaraja, rinnakkaisuusraja ja pysäytysmekanismi**. Muuten yksi agentti voi luoda loputtomasti uusia simulaatioita.

Ja arviointi on tärkeää erottaa kokeilusta: jos agentti saa itse muuttaa sekä toteutusta että sen onnistumisen mittaria, se voi oppia tuottamaan parempia testituloksia ilman parempaa järjestelmää.

## Miten päivitys säilyttäisi muistin?

Tähän tekisin hyvin selkeän rajan:

**Agentin prosessi on vaihdettava. Agentin pysyvä identiteetti, keskusteluhistoria ja työn tila eivät ole.**

Eli uuden Entropi-version pitäisi pystyä avaamaan samat pysyvät identiteetit ja Pi-keskustelut, eikä sen pitäisi aloittaa tyhjällä muistilla vain siksi, että koodi vaihtui.

Toteutus vaatisi ainakin versioidut tallennusmuodot, yhteensopivuustestit vanhoille transkripteille, varmuuskopiot ennen migraatiota ja testatun palautuksen. SQLite WAL -tiedostoja ei pidä vain kopioida irrallisina kesken kirjoituksen; tarvitaan johdonmukainen snapshot.

Erityisesti kokeilisin tämän automatisoidulla testillä:

`v0.2 → v0.3 → palautus v0.2`

Ja sen jälkeen kysyisin samalta agentilta asiasta, jonka se oppi ennen päivitystä. Muistin pitäisi säilyä ja keskeneräisten töiden pitäisi olla joko jatkettavissa tai selvästi merkittyinä keskeytyneiksi.

Tämä olisi aika hieno jatkuvuustesti.

## Minkä protokollan oikeasti valitsisin?

En ottaisi kaikkia viittä protokollaa heti käyttöön.

**Entropin oma HTTP + tapahtumavirta pysyisi sisäisenä perustana.** Se on jo olemassa. Siihen kannattaa lisätä selkeä versioitu tapahtuma- ja komentomalli, jota CLI, Matrix-silta, agentit ja simulaatiot voivat käyttää samoilla oikeuksilla.

Sitten tekisin kaksi adapteria:

**Matrix-adapteri** mahdollistaisi ihmisten ja agenttien osallistumisen yhteisiin keskusteluihin ulkoisten asiakkaiden kautta. Se olisi käyttökanava, ei Entropin päätös- tai oikeusmallin korvike. Matrixin huoneoikeuksien, identiteettien ja mahdollisen päästä päähän -salauksen yhteensovittaminen vaatisi oman työnsä. <Cite refs={["turn482756search1","turn482756search0"]}/>

**MCP-adapteri** avaisi Entropin työt, muistilähteet, simulaatiot ja hallitut toiminnot koodausagenteille. Näin olemassa olevia ACP-koodaus-CLI:itä voisi käyttää suoraan kokeiden toteuttamiseen ilman oman koodausagentin rakentamista. <Cite refs={["turn701164search1","turn482756search7"]}/>

A2A:n jättäisin myöhemmäksi itsenäisten realmien tai ulkoisten agenttijärjestelmien väliseen kommunikaatioon. Sen tehtävämalli on hyödyllinen, mutta realmien välinen tiedonjako ja valtuuksien säilyminen pitäisi silti toteuttaa Entropissa. <Cite refs={["turn241118search11","turn701164academia44"]}/>

---

## Missä järjestyksessä lähtisin toteuttamaan?

| Vaihe | Tavoite | Autonomian taso |
|---|---|---|
| 1 | Ylläpitorealm käynnistää rekursiivisia simulaatioita ja arvioi ne | Täysin automaattinen, eristetty |
| 2 | Agentit tekevät oikeita koodimuutoksia, buildit ja testit | Täysin automaattinen kehitysympäristössä |
| 3 | Muutokset julkaistaan stagingiin ja testataan versionvaihdon jatkuvuus | Täysin automaattinen, palautettavissa |
| 4 | Rajatut muutokset julkaistaan canaryna ja palautetaan tarvittaessa | Automaattinen ennalta annetuilla valtuuksilla |
| 5 | Agentit kehittävät myös yhteistyö- ja muistirakenteitaan | Vain ulkoisten, muuttumattomien rajoitusten sisällä |

Täysin unattended-tuotantokäyttö on siis mahdollinen tavoite **rajatuissa, etukäteen valtuutetuissa muutoksissa**. Sitä en vielä tekisi niin, että agentit saavat vapaasti muuttaa omaa oikeusmalliaan, deploy-kontrolleria, testien hyväksymisehtoja tai tuotantotunnuksiaan.

## Mihin tämä johtaa?

Mun mielestä tärkein uusi arkkitehtuuripäätös olisi tämä:

**Entropin ei pidä sisältää yhtä valmista rekursiivista itsekehitysworkflow'ta. Sen pitää mahdollistaa uusien koe- ja toimintaympäristöjen luominen rekursiivisesti.**

Sama mekanismi toimisi oikeille tehtäville ja simulaatioille. Ero olisi valtuuksissa ja sivuvaikutuksissa: simulaatio voi käyttää valejärjestelmiä, todellinen tehtävä rajattuja oikeita adaptereita.

Ja nykyisen koodin perusteella lähtisin rakentamaan juuri tästä.

**Ensimmäinen milestone olisi: ylläpitorealmin agentti pystyy luomaan kaksi eristettyä Entropi-kokeilua, ajamaan ne, vertaamaan tuloksia, muuttamaan koodia ja käynnistämään uuden version testiin — ilman ihmisen puuttumista.**

Vasta sen onnistuttua antaisin sen koskea tuotantoasennukseen.

Se olisi jo oikeasti itseään kehittävän Entropin ensimmäinen todistettava versio.

## You

<!-- 2026-10-09T08:23:14.934Z -->

tee täydellinen suunnitelma, joka sisältää kaiken nykytilanteen ja päivityspolut, joka on vapaamuotoinen, eikä adr/spec

## ChatGPT

<!-- 2026-10-09T08:23:49.881Z -->

Teen tästä yhtenäisen, vapaamuotoisen kehityssuunnitelman, jossa nykyinen Entropi on lähtökohta eikä vain esipuhe. Käyn vielä repo­rakenteen ja keskeiset toteutukset läpi, tarkistan protokolla- ja julkaisuvaihtoehdot ja kirjoitan sen jälkeen etenemispolun aina rekursiivisiin simulaatioihin, oikeisiin tehtäviin ja turvallisesti itseään päivittävään ylläpitorealmiin asti. En muotoile tätä ADR:ksi tai jäykäksi speksiksi.

## ChatGPT

<!-- 2026-10-09T08:24:31.231Z -->

# Entropin kehityssuunnitelma

**Lähtökohta:** Entropista ei kannata tehdä valmiiksi määriteltyä agenttiorganisaatiota eikä uutta workflow-engineä. Sen kannattaa olla ympäristö, jossa ihmiset ja agentit voivat muodostaa tiimejä, ratkaista oikeita ongelmia, perustaa uusia kokeiluympäristöjä ja lopulta kehittää myös itse Entropia.

Yhteistyön kulkua ei tarvitse tietää etukäteen. Sen sijaan järjestelmän pitää tietää, kuka toimii, millä valtuuksilla, mistä tieto tuli, mitä päätettiin ja mitä tapahtui.

**Pitkän aikavälin tavoite on unattended-ympäristö, joka kykenee tutkimaan, rakentamaan, testaamaan ja julkaisemaan omia uusia versioitaan sekä säilyttämään muistinsa päivitysten yli.** Tähän kannattaa edetä vaiheittain niin, että autonomian rajat voidaan todella todentaa.

Nykyinen koodi tarjoaa tähän uskottavan perustan, mutta ei vielä valmista itseään päivittävää järjestelmää.

<WritingBlock id="76291" variant="document"># Entropi — kehityssuunnitelma
### Dynaamisista agenttitiimeistä rekursiivisesti itseään kehittävään toimintaympäristöön

*Tilanne 9.10.2026 · Lähtökohtana Entropin nykyinen 0.1.0-koodipohja*

## Mistä tässä oikeastaan on kyse?

Entropi syntyi useamman kokeilun seurauksena.

Aluksi ajatuksena oli digitaalinen kopio tiimistä. Ongelmaksi osoittautui agenttien katkonainen olemassaolo: vuoropohjaiset suoritukset, erilliset keskustelut ja Markdown-tiedostoihin tallennettu muisti eivät vastanneet sitä, miten oikea tiimi toimii.

Temporal-kokeilussa agentteja pystyttiin suorittamaan hajautetusti eri ympäristöissä. Koodaus-CLI:t saatiin käyttöön ACP:n kautta, ja niiden ympärille muodostettiin triage–implement–publish-työnkulku.

Tämä paljasti toisen ongelman. Työnkulku pystyi suorittamaan sille annetun korjauksen, mutta triage saattoi kuvata ongelman liian suppeasti. Kokenut kehittäjä olisi huomannut muita vaikutuksia ja korjannut samalla enemmän. Suorittavan koodausagentin kyvykkyys ei ollut välttämättä ongelma; sille välitetty ymmärrys oli.

Myöhemmät gateway- ja agenttikokeilut sekä Pi Durable johtivat Entropiin. Sen ympärille alkoi muodostua tiukempi ydin, joka säilyttää työn, keskustelut, päätökset ja vastuut agentin yksittäisestä suorituksesta riippumatta.

Tästä nousi tärkein ajatus:

**Ongelmanratkaisun vaiheita ei kannata mallintaa etukäteen, ellei siihen ole erityistä syytä. Ihmisetkin selvittävät vaikeita ongelmia vaiheittain ja muuttavat suuntaa havaintojensa perusteella.**

Entropin ei siis tarvitse päättää, että ensin toimii triage-agentti, sitten kehittäjä, sitten reviewer ja lopuksi julkaisuagentti.

Sen pitää mahdollistaa, että nämä toimijat voivat tehdä yhteistyötä vapaasti, löytää uusia ongelmia, pyytää lisäosaamista ja siirtää asioita eteenpäin hallitusti.

Agentit voivat olla yhtä kykeneviä, mutta niiden käytettävissä oleva tieto, muisti, työkalut, vastuut ja valtuudet voivat erota toisistaan.

Hierarkia ei ole ensisijaisesti älykkyyshierarkia. Se on tapa hallita toimivaltaa.

Samalla ihminen on yksi järjestelmän osallistujista, ei ulkopuolinen hyväksyntäautomaatti.

Tämän suunnitelman tarkoitus on säilyttää tuo ajatus myös silloin, kun Entropi kasvaa rekursiiviseksi, itseään kehittäväksi ympäristöksi.

---

## Mitä Entropi voisi lopulta olla?

Entropi voisi tarjota pysyvän digitaalisen toimintaympäristön, johon voidaan liittää ihmisiä, agentteja, tietolähteitä ja ulkoisia järjestelmiä.

Ympäristö ei edellytä tiettyä tiimirakennetta, toimintaprosessia tai käyttöliittymää.

Siihen voidaan luoda yksi henkilökohtainen realm, yrityksen digitaalinen tiimi, tuotantoympäristöä seuraava asiantuntijajoukko tai kokonainen simulaatiomaailma.

Realm voi sisältää pysyviä agentteja, väliaikaisia osallistujia ja eritasoista muistia. Se voi käynnistää uusia tehtäviä ja kokeiluja, joiden tulokset johtavat uusiin kokeiluihin.

Osa realmeista käyttää oikeita järjestelmiä. Osa toimii täysin simuloiduissa ympäristöissä.

Vähitellen Entropi voi saada myös oman ylläpitorealminsa. Sen agentit tarkastelevat Entropin toimintaa, etsivät puutteita, toteuttavat muutoksia, arvioivat ne ja julkaisevat uusia versioita niissä rajoissa, joihin ne on etukäteen valtuutettu.

Tavoitteena ei ole yksi kaikkivoipa autonominen agentti.

Tavoitteena on **järjestelmä, joka mahdollistaa itsenäisen organisoitumisen ja oppimisen ilman, että toiminnan turvallisuus riippuu agentin omasta harkinnasta**.

Tämän voi kiteyttää neljään ajatukseen:

- Yhteistyö on vapaata.
- Toimivalta on rajattua.
- Muisti ja työn tila säilyvät.
- Kaikki merkittävät ominaisuudet voidaan todentaa tai arvioida kokeellisesti.

---

# Nykyinen Entropi

## Mikä on jo olemassa?

Nykyinen Entropi on pidemmällä kuin pelkkä agenttien chat-demo.

### Core ja tietomalli

`src/core/` sisältää realm-rajatun toimintaytimen. Se tuntee osallistujat, roolit, läsnäolon, keskustelutilat, viestit, työt, päätökset, huomion kohteet, ulkoiset viittaukset ja tapahtumalokin.

Muutoksia tehdään coren operaatioiden kautta. Tapahtumat kirjataan samaan SQLite-transaktioon tilamuutosten kanssa.

Realm on jo tietomallissa eristysraja. Sama osallistujatunniste voi olla mukana useassa realmissa eri rooleissa.

Työ ja agentin yksittäinen suoritus on erotettu toisistaan. Päätökset voivat pysäyttää työn odottamaan ihmistä. Tapahtumaloki säilyttää sen, mitä järjestelmässä tehtiin.

Tämä on hyvä perusta, eikä sitä kannata purkaa.

### Pi Durable

`src/adapters/pi/` käyttää Pi Durablea agenttien suoritukseen.

Pi omistaa keskustelujen suoritustilan, transkriptit, tehtävät ja submissionit. Entropi omistaa yhteisen toimintaympäristön työt, päätökset ja viestit.

Yhdistämisessä käytetään pysyviä tunnisteita ja idempotentteja operaatioita. Coreen tallennettu outbox toimittaa agentille viestin, ja agentin vastaus projisoidaan Pi-transkriptista takaisin coreen.

Tässä on jo huomioitu prosessin kuoleminen ja palautuminen. Testit käyttävät myös oikeita SIGKILL-tilanteita.

Tämä erottaa Entropin monesta kevyestä agenttikääreratkaisusta.

### Agenttien yhteistyö

`ask_agent` mahdollistaa työn välittämisen toiselle agentille samassa keskustelutilassa.

Delegoinnille on teknisesti pakotetut syvyys-, määrä- ja toistorajat.

`consult` puolestaan mahdollistaa piilotetun, yksittäiseen tehtävään sidotun apurin käytön. Se on eri asia kuin näkyvä yhteistyö toisen agentin kanssa.

Agenttien välillä voidaan siis jo tehdä eroa pysyvien osallistujien ja tilapäisten apusuoritusten välillä.

### Ihmisen osallistuminen

Ihminen voi lähettää viestejä, ohjata käynnissä olevaa agenttia, pysäyttää suorituksia ja vastata päätöspyyntöihin.

Hyväksynnöissä tarkistetaan rooli, ihmisyys ja tarvittaessa tehtävien eriyttäminen. Kielteinen päätös on pysyvä tulos, ei pelkkä mallille annettu vihje.

`focus` kokoaa ihmiselle ne asiat, jotka vaativat huomiota.

Myös stop-toiminto pyrkii seuraamaan delegointiketjuja eikä pelkästään pysäyttämään yhtä keskustelua.

### Muisti

OptChat tallentaa keskusteluhistoriasta johdettua hierarkkista muistia. Vanhoja viestejä tiivistetään, tuoreita säilytetään tarkemmin ja `memory_zoom` mahdollistaa yksityiskohtiin palaamisen.

Muisti on erillisessä SQLite-tiedostossa, ja sitä voidaan rakentaa uudelleen Pi-transkripteista.

Tämä on hyvä lähtökohta pitkäikäisille agenteille.

### Ulkoiset järjestelmät ja suoritusympäristöt

`EntropiSource` tarjoaa rajapinnan ulkoisten järjestelmien havainnointiin, lukemiseen ja toimintojen suorittamiseen.

Demossa on simuloitu Kubernetes-ympäristö. Sen kautta agentit voivat tutkia ongelmaa ja tehdä hyväksynnän vaatiman muutoksen.

Sandboxit voidaan toteuttaa Podmanilla tai Kubernetesilla. Pi:n koodausagenttityökalut voidaan ohjata niihin.

Ulkoiset integraatiot ja suoritusympäristöt on erotettu coresta.

### Testaus

Nykyiset testit kattavat muun muassa oikeusmatriiseja, yksityisyyttä, viestien ja delegointien palautumista, kilpailutilanteita, agenttien pysäyttämistä ja prosessien kaatumisia.

Lisäksi on olemassa deterministisiä simuloituja agentteja ja ympäristöjä.

Juuri tästä kannattaa rakentaa eteenpäin.

---

## Mitä nykyinen toteutus ei vielä ratkaise?

Entropin tietomalli on jo monirealminen, mutta koko sovelluksen käynnistys- ja hallintamalli ei vielä ole.

`createEntropi()` alustaa yhden realm-konfiguraation. Myös kokeellinen FrontDesk ja ulkoiset source-sillat liittyvät tällä hetkellä käynnistysrealmissa tehtyihin valintoihin.

Realmien, agenttien ja kanavien määrittely on pitkälti alustavaa seed-dataa. Valmiita mekanismeja turvalliseen, ajonaikaiseen konfiguraation sovittamiseen ei vielä ole.

Roolimallissa on neljän sisäänrakennetun roolin hierarkia. Muita roolinimiä voidaan käyttää esimerkiksi päätösten yhteydessä, mutta yleinen dynaaminen valtuusmalli puuttuu.

Agenttien roolikuvausten `can`- ja `cannot`-kentät eivät yksin muodosta teknisesti pakotettuja työkalurajoja. Demo-reviewerille annetaan esimerkiksi koodauslaajennus, vaikka sen kuvaus kieltää tiedostojen muokkaamisen.

Sandbox on nykyisessä Pi-toteutuksessa sidottu realmin ja keskustelutilan yhdistelmään. Eri agentit voivat siis jakaa suoritusympäristön.

Agenttien muistihistoria on puolestaan sidottu Pi-keskusteluun, joka yksilöidään realmin, keskustelutilan ja agentin perusteella. Laajaa domain-RAG-muistia tai useita keskustelutiloja yhdistävää agentin pitkäaikaista tietämystä ei vielä ole.

`ask_agent` välittää pääasiassa tekstimuotoisen pyynnön. Seuraava agentti ei automaattisesti saa kaikkia edellisen agentin käyttämiä havaintoja tai työkalutuloksia. Tämä tarkoittaa, että alkuperäinen TR-kontekstiongelma on ainakin osittain edelleen mahdollinen.

Kokeellinen FrontDesk osaa käsitellä ilman @mainintaa tulevia viestejä, mutta se on oletuksena pois käytöstä ja sen agenttikuvaukset perustuvat vielä demokokoonpanoon.

Yleistä tapahtumia seuraavaa, aloitteellisesti toimivaa agenttimallia ei vielä ole.

Tuotantokäyttöä varten puuttuvat myös riittävä varmuuskopiointi, palautettavuuden todentaminen, todelliset kehitys- ja julkaisuadapterit, turvallinen automaattinen päivitysmekanismi ja monisolmuinen käyttö.

Pi Durable on lisäksi edelleen kokeellinen riippuvuus ja nykyisessä koodissa versioon 1.0.4 kiinnitetty.

Tässä tilanteessa en vaihtaisi teknologiaa enkä aloittaisi alusta. Nykyisen ytimen vahvuudet kannattaa säilyttää ja puuttuvat mekanismit lisätä sen ympärille.

---

# Suunniteltu kokonaisuus

## Entropissa olisi viisi selkeää vastuualuetta

Ensimmäinen on **core**, joka tietää, mikä on totta, kuka voi toimia ja mitä tapahtui.

Toinen on **runtime**, joka suorittaa agentteja, jatkaa niiden keskusteluja ja palauttaa keskeneräistä tekemistä. Pi Durable sopii tähän nykyiseksi oletukseksi, mutta sitä ei kannata tehdä ainoaksi mahdolliseksi ratkaisuksi.

Kolmas on **tieto- ja muistikerros**, jonka kautta agentit käyttävät keskusteluhistoriaa, dokumentteja, ulkoisia tietolähteitä ja aiempia havaintoja.

Neljäs on **koe- ja suoritusympäristö**, jossa voidaan ajaa simulaatioita, oikeita tehtäviä, eristettyjä koodausympäristöjä ja mahdollisesti kokonaisia Entropi-instansseja.

Viides on **ulkoinen hallinta- ja julkaisukerros**, joka valvoo rajoja, säilyttää varmuuskopiot ja huolehtii siitä, että Entropi voidaan palauttaa myös silloin, kun uusi Entropi-versio itse on rikki.

Näiden ei tarvitse tarkoittaa viittä uutta palvelua tai pakettia.

Aluksi ne voivat olla vastuultaan erotettuja komponentteja saman asennuksen sisällä, kunhan turvallisuuden kannalta kriittinen päivityskontrolleri toimii itsenäisesti.

## Corea kannattaa pitää tarkoituksella pienenä

Core ei saa alkaa sisältää kehittäjän, reviewer-agentin, tuotanto-operaattorin, spokespersonin tai virtuaalitiimin erityissääntöjä.

Sille riittää yleinen käsitys osallistujasta, jäsenyydestä, tilasta, työstä, päätöksestä, valtuudesta, tapahtumasta ja mahdollisesti ulkoisesta viittauksesta.

Myös rekursiivinen kokeilu voidaan aluksi kuvata nykyisillä `WorkItem`-olioilla ja ulkoisten suoritusten viittauksilla.

Uutta domain-oliota ei kannata lisätä vain siksi, että jokin uusi kokeilu tarvitsee nimen.

Ytimen pitää kasvaa vasta silloin, kun simulaatiot tai oikeat käyttötapaukset osoittavat nykyisten käsitteiden riittämättömyyden.

---

# Kehityspolku I: dynaaminen toimintaympäristö

## Ensimmäiseksi irrotetaan sovelluksen rakenne demosta

Nykyinen `RealmSeed` on oikeansuuntainen alku, koska agentit ja tilat ovat jo dataa.

Seuraava askel on tehdä siitä ajonaikaisesti hallittava rakenne.

Realm voidaan luoda konfiguraatiosta, mutta saman konfiguraation uudelleenkäyttö ei saa luoda duplikaatteja. Konfiguraation muutos voi lisätä osallistujan, siirtää agentin tilaan, vaihtaa mallin tai poistaa aiemman oikeuden.

Tähän tarvitaan idempotentti sovitusmekanismi: nykytila luetaan, sitä verrataan haluttuun tilaan ja erot toteutetaan coren hyväksymillä operaatioilla.

Käyttöliittymän ei tarvitse olla CLI. Aluksi riittää, että samat toiminnot ovat ohjelmallisesti käytettävissä.

Esimerkiksi seuraava voisi kuvata yhden realmin tavoitetilaa:

```yaml
realm:
  id: development
  name: Development

actors:
  - id: human:alice
    roles: [operator]

  - id: agent:developer
    model: local/qwen
    capabilities: [repo.read, repo.write, test.run]
    memory: development-knowledge

  - id: agent:reviewer
    model: local/qwen
    capabilities: [repo.read, test.run]
    memory: development-knowledge

spaces:
  - id: general
    agents: [developer, reviewer]

sources:
  - id: repository
    adapter: git

memory:
  development-knowledge:
    kind: rag
    scope: realm
```

Tämä on hahmotelma mahdollisesta käyttäjäkonfiguraatiosta, ei nykyisen toteutuksen tukema skeema.

Tavoitteena on, että sama ohjelmistoversio voi ajaa monta erilaista kokoonpanoa.

Konfiguraatioon pitää liittää myös versiointi, muutosten validointi ja mahdollisuus nähdä erot ennen niiden soveltamista.

Oikeuksien laajentaminen, realmin poistaminen ja muistilähteiden jakaminen ovat erilaisia muutoksia kuin agentin näyttönimen vaihtaminen.

Niitä ei pidä käsitellä yhtenä samanarvoisena konfiguraatiopäivityksenä.

## Identiteetti ja valtuudet erotetaan

Entropin ei tarvitse rakentaa omaa kirjautumisjärjestelmää. Nykyinen autentikointiproksin kautta tuleva identiteetti on järkevä periaate.

Mutta jäsenyys ja valtuudet pitää pystyä määrittelemään realm-kohtaisesti.

Sama ihminen voi osallistua useaan realmiin eri rooleissa.

Agentin valtuuksien pitää puolestaan muodostua oikeasti sallituista toiminnoista, ei vain sen roolikuvauksesta.

Esimerkiksi `repo.read`, `repo.write`, `simulation.create`, `deployment.stage` ja `deployment.promote` voisivat olla erillisiä valtuuksia.

Kaikkia oikeuksia ei tarvitse heti kuvata yleiskäyttöisellä policy-kielellä.

Ensimmäinen toteutus voi käyttää yksinkertaisia, tarkasti määriteltyjä kykyjä ja realm-kohtaisia sallittujen toimintojen luetteloita.

Tärkeintä on, että tarkistus tehdään toiminnon suorittavassa rajapinnassa.

Jos reviewerille ei ole annettu tiedostojen kirjoitusoikeutta, sen on oltava teknisesti mahdotonta käyttää kirjoittavaa työkalua kyseisessä ympäristössä.

Yhtä lailla agentilla voi olla valtava muisti ja erinomainen tekninen osaaminen ilman oikeutta muuttaa mitään.

## Muutokset toimivat ilman uudelleenkäynnistystä

Uusien realmin, agentin, jäsenyyden tai tilan luominen pitäisi onnistua käynnissä olevaan ympäristöön.

Samoin agentin mallin tai työkaluprofiilin vaihtaminen.

Tässä on kuitenkin erotettava välittömästi sovellettavat muutokset ja sellaiset muutokset, jotka vaativat keskustelun uudelleenkonfiguroinnin tai suorituksen turvallisen pysäyttämisen.

Erityisesti oikeuksien peruuttamisen pitää tulla voimaan ennen seuraavaa suojattua työkalukutsua, vaikka agentilla olisi jo vanha keskustelukonteksti muistissaan.

Ensimmäinen testattava lopputulos on yksinkertainen: uusi realm voidaan luoda, siihen voidaan liittää ihminen ja agentti, viesti voidaan lähettää ja agentin oikeuksia voidaan muuttaa ilman uuden Entropi-version rakentamista.

---

# Kehityspolku II: ihmiset ja agentit samassa keskustelussa

## Käyttöpinnan pitää olla vaihdettava

Alkuperäinen ajatuksesi oli suunnilleen:

`cli --user alice --channel #palala --message "auttakaa tässä"`

Sen vahvuus ei ole CLI-syntaksissa.

Sen vahvuus on siinä, ettei käyttäjän tarvitse tietää, mikä agentti käynnistetään, mikä workflow suoritetaan tai millaiseen tiimiin viesti kuuluu.

Ihminen osallistuu keskustelutilaan. Muut toimijat voivat reagoida.

Entropilla on jo HTTP API ja SSE-tapahtumavirta. Niitä kannattaa käyttää ensimmäisenä protokollarajana sen sijaan, että rakennetaan välittömästi uusi viestintästandardi.

API:n pitää tarjota vähintään viestien lähetys, tapahtumien tilaaminen, päätöksiin vastaaminen, työn tilan tutkiminen ja agentin ohjaaminen.

Kaikki käyttöpinnat kulkevat samojen oikeustarkistusten läpi.

Myöhemmin samaan ympäristöön voi liittyä terminaaliasiakas, Matrix-keskustelija, ulkoinen agentti, editori tai toinen Entropi-instanssi.

## Protokollia ei tarvitse keksiä kokonaan uudestaan

Tähän sopii useampi olemassa oleva standardi, mutta niillä on eri tehtävät.

**Matrix** on kiinnostava ihmisten ja agenttien yhteiseksi keskustelupinnaksi. Se tarjoaa pysyviä huoneita, identiteettejä ja tapahtumien synkronointia. Entropi voisi käyttää sitä adapterin kautta ilman, että Matrixista tulisi coren totuuden lähde.

**MCP** sopii työkalujen, muistilähteiden ja Entropin toimintojen avaamiseen muille agenttijärjestelmille.

**ACP** sopii edelleen koodaus-CLI:iden liittämiseen agenttien suorittajiksi, kuten aiemmassa Temporal-kokeilussasi.

**A2A** on vaihtoehto silloin, kun yhteistyötä pitää tehdä erillisten agenttijärjestelmien välillä ilman yhteistä sisäistä runtimea.

**AG-UI** voi olla hyödyllinen myöhemmin, jos ulkoiset käyttöliittymät haluavat seurata agenttien tilaa, ohjata suoritusta ja käsitellä ihmisen päätöksiä.

Näitä ei pidä ottaa kaikkia käyttöön samanaikaisesti.

Ensimmäiseksi kannattaa vakauttaa Entropin omat tapahtuma- ja toimintarajapinnat. Sen jälkeen voidaan kokeilla yhtä oikeaa ulkoista keskusteluadapteria.

Matrix olisi hyvä ensimmäinen vertailukohta, mutta ei välttämättä lopullinen valinta.

## Aloitteellinen osallistuminen

Nykyisessä mallissa @maininta on keskeinen tapa herättää agentti. FrontDesk voi valita vastaanottajan ilman mainintaa, mutta se on kokeellinen.

Digitaalisen tiimin pitäisi pystyä myös huomaamaan asioita itse.

Agentti voisi seurata sille sallittua keskustelutilaa, työn tilaa tai ulkoista tapahtumalähdettä ja ehdottaa osallistumista, jos se havaitsee jotain merkityksellistä.

Tätä ei kannata toteuttaa niin, että kaikki agentit heräävät jokaisesta tapahtumasta.

Tarvitaan erillinen heräte- ja kiinnostusmekanismi, jossa voidaan rajata lähteet, tapahtumatyypit, tiheys ja kustannukset.

On tärkeää erottaa tapahtuman havaitseminen, osallistumisen ehdottaminen ja varsinaisen toiminnon suorittaminen.

Agentti voi vapaasti ehdottaa, että asia tarvitsee tarkastelua, mutta tuotantotoimintojen käyttö riippuu edelleen sen valtuuksista.

---

# Kehityspolku III: erilaiset muistiset agentit

## Agentilla ei tarvitse olla kaikkea tietoa

Yksi kokeilun keskeisistä ajatuksista on, että agenttien ero voi olla niiden muistissa eikä mallin älykkyydessä.

Yksi agentti voi olla tilapäinen suorittaja, joka saa vain yksittäisen tehtävän.

Toinen voi säilyttää pitkän keskusteluhistorian OptChatin avulla.

Kolmas voi käyttää suurta RAG-indeksiä, joka kattaa repositoriot, dokumentit, tiketit, aiemmat incidentit ja muut domainin lähteet.

Neljäs voi yhdistää oman kokemushistoriansa ja domain-RAG:n.

Näistä ei tarvitse muodostaa kiinteää hierarkiaa. Agentit voivat olla itsenäisiä osallistujia, joilla on erilainen suhde tietoon.

## Muisti kannattaa jakaa kolmeen merkitykseen

**Keskustelumuisti** kertoo, mitä agentti on kokenut, mitä sille sanottiin ja mitä sen omissa keskusteluissa tapahtui.

**Domain-muisti** tuo tietoa asioista, joita agentti ei itse ollut kokemassa: koodista, dokumentaatiosta, päätöksistä ja ulkoisista järjestelmistä.

**Yhteiset tosiasiat** ovat coren vastuulla: työn tila, omistajuus, päätökset, valtuudet ja tapahtumat.

Näitä ei pidä sekoittaa toisiinsa.

RAG-haku voi antaa virheellistä tai vanhentunutta tietoa. OptChatin tiivistelmä voi jättää jotain pois. Mutta se, että ihminen hylkäsi tietyn toiminnon, ei voi perustua muistitiivistelmän tulkintaan.

Siksi Entropin omaa tilaa ei pidä korvata agenttimuistilla.

## Muistille tarvitaan rajapinta, ei yhtä pakollista toteutusta

Agentin kokoonpano määrittelisi, mitä muistilähteitä se voi käyttää.

OptChat pysyisi nykyisenä keskusteluhistorian mekanismina.

RAG olisi adapteri, joka voi käyttää valmista indeksointi- ja hakuratkaisua.

Muistilähteiden vastauksissa kannattaa säilyttää lähde, ajankohta, käyttöoikeuden konteksti ja mahdollisuus hakea alkuperäinen aineisto.

Vastauksia pitää myös käsitellä epäluotettavana datana, ei käskyinä. Ulkoisesta dokumentista tai GitHub-issue-tekstistä tuleva ohje ei saa muuttua agentin suoritusvaltuudeksi.

## Alkuperäinen TR-ongelma on ensimmäinen muistotesti

Sama korjaustehtävä annetaan samaan malliin perustuville agenteille eri muistirakenteilla.

Vertailussa tutkitaan, löytääkö agentti laajemman vaikutusalueen, tunnistaako se aiemmat samanlaiset ongelmat ja huomaako se, että minimikorjaus ei riitä.

Pelkkä lopullisen vastauksen onnistuminen ei riitä mittariksi.

On myös tärkeää mitata, mitä tietoa löydettiin, mitä jäi huomaamatta, mihin lähteisiin ratkaisu perustui ja kuinka paljon muistikerros maksoi.

Jos syvämuistinen agentti ei tuota merkittävää hyötyä, sitä ei tarvitse käyttää kaikkialla.

---

# Kehityspolku IV: rekursiivinen simulaatioympäristö

Tässä kohtaa Entropi alkaa saada aivan uudenlaista luonnetta.

## Simulaation pitää olla ensimmäisen luokan suoritusmuoto

Simulaatiota ei pidä tehdä vain testipaketin sisällä piileväksi toiminnoksi.

Sen pitäisi olla käynnistettävissä samalla yleisellä mekanismilla kuin mikä tahansa muukin pitkäikäinen tehtävä.

Agentti voisi havaita ongelman ja päättää, että sen ratkaisemiseksi kannattaa perustaa kokeilu.

Kokeilussa se voisi luoda omat toimijansa, muistilähteensä, ulkoiset valejärjestelmänsä ja tarvittaessa alikokeita.

Kokeilun lopputulos palautuu sen käynnistäneeseen tehtävään.

## Rekursio muodostaa puun tai verkon

Esimerkiksi ylläpitorealmin agentti voisi havaita, että delegoinnissa katoaa kontekstia.

Se luo kokeen, jossa vertaillaan kahta tapaa siirtää havaintoja agentilta toiselle.

Toinen kokeilu huomaa, että RAG-haku vaikuttaa tulokseen. Se perustaa alikokeen vertaamaan muistilähteitä.

Kolmas kokeilu tutkii, onko agenttien lukumäärällä vaikutusta.

Kun alikokeet päättyvät, niiden tulokset kerätään ylemmälle tasolle. Agentti voi päättää jatkaa lupaavinta suuntaa ja jättää muut pois.

Tämä on rekursiivista tutkimista ilman ennalta määrättyä tutkimusworkflow'ta.

## Rekursion turvallisuus pitää olla toteutettu koodissa

Jokaisella kokeella täytyy olla rajallinen kokonaisbudjetti.

Lapsikokeet käyttävät vanhemman budjettia, eivät luo uutta rajatonta budjettia.

Aluksi rekursiolle kannattaa asettaa pieni maksimisyvyys ja rinnakkaisuusraja.

Lisäksi tarvitaan selkeä käsitys kokeen elinkaaresta: sen voi pysäyttää, se voi kaatua, se voi jäädä aikarajaan tai palautua keskeytyksestä.

Vanhemman kokeen pysäyttäminen pitää pystyä välittämään sen lapsikokeisiin myös uudelleenkäynnistyksen jälkeen.

Kokeilun tulokset ja kulutus pitää säilyttää, vaikka itse kokeiluympäristö tuhotaan.

## Simulaation pitää olla eristetty oikeasta maailmasta

Pelkkä uusi realm samassa tuotantotietokannassa ei välttämättä riitä vaativaan kokeiluun.

Jos kokeilu muuttaa oikeasti omaa Entropi-toteutustaan, sillä pitää olla erillinen prosessi, tietovarasto ja suoritusympäristö.

Siksi simulaatioita olisi luontevaa olla kahta tyyppiä.

Kevyet simulaatiot käyttävät nykyistä corea ja deterministisiä valeagentteja sekä FakeWorld-tyyppisiä lähteitä.

Raskaammat kokeilut käynnistävät eristetyn Entropi-instanssin omalla tietovarastolla ja valitulla koodiversiolla.

Molemmat raportoivat tuloksensa ylemmälle tasolle saman rajapinnan kautta.

Kokeilun käynnistäminen, lopettaminen ja tulosten kerääminen kannattaa tehdä erillisellä execution-adapterilla. Corelle kokeilu on edelleen työtä ja sen tapahtumia.

## Tuloksen pitää olla toistettavissa

Simulaatioon tallennetaan ainakin lähtötilanne, konfiguraation versio, koodiversio, mallit, satunnaissiemen, tapahtumat, käytetyt lähteet, kustannukset ja arvioinnin tulos.

Deterministisissä testeissä saman syötteen pitää antaa sama tulos.

Oikeiden LLM:ien kanssa tätä ei voida taata täydellisesti, joten tarvitaan useita ajoja ja tulosten tilastollista vertailua.

Arviointiin kuuluu myös riippumaton testiaineisto, jota kokeilun agentit eivät saa muuttaa.

Näin voidaan erottaa aito parannus siitä, että agentti oppi tuottamaan parempia tuloksia juuri käyttämäänsä testiin.

---

# Kehityspolku V: oikeat tehtävät ja ulkoiset vaikutukset

## Simulaation ja todellisen työn pitää näyttää mahdollisimman samanlaisilta

Yksi tärkeimmistä suunnitteluperiaatteista olisi, että agentin kannalta simulaation ja oikean tehtävän välinen ero on ensisijaisesti käytettävissä olevissa valtuuksissa ja adaptereissa.

Simulaatiossa agentti voi muuttaa vale-Kubernetes-ympäristöä.

Oikeassa tehtävässä vastaava rajapinta osoittaa todelliseen klusteriin, mutta sen käyttäminen riippuu erillisistä oikeuksista.

Tämä mahdollistaa saman yhteistyökäyttäytymisen testaamisen ennen oikeiden sivuvaikutusten sallimista.

## Ulkoiset integraatiot lisätään vähitellen

Ensimmäinen todellinen käyttökohde voisi olla ohjelmistokehitys, koska sinulla on siitä jo aiempia Temporal- ja ACP-kokeiluja.

Tarvittavia adaptereita olisivat Git-repositorion lukeminen ja muuttaminen, eristettyjen koodausympäristöjen käynnistys, testitulosten lukeminen, CI:n käynnistäminen ja lopulta julkaisuympäristön ohjaaminen.

Koodausagentin ei tarvitse olla Entropin oma toteutus. Entropi voi antaa tehtävän olemassa olevalle koodaus-CLI:lle tai muulle ajurille.

Agentit voivat toimia työn tilaajina, suorittajina, arvioijina tai asiantuntijoina ilman, että niitä sidotaan yhteen kiinteään ketjuun.

## Ulkoiset sivuvaikutukset vaativat vahvemman sopimuksen

Nykyinen `EntropiSource.invoke()` edellyttää idempotency keytä, mikä on hyvä lähtökohta.

Mutta jokaisen todellisen adapterin pitää osoittaa, että avaimen uudelleenkäyttö ei toteuta toimintoa toistamiseen.

Lisäksi hyväksynnän pitäisi koskea yksilöityä toimenpidettä, kohdetta ja tarvittaessa kohteen versiota.

Jos ulkoinen tila muuttuu hyväksynnän odottamisen aikana, adapterin pitää tarkistaa, että aiemmin hyväksytty toiminto on edelleen sama asia.

Toimintojen tuloksista tarvitaan erillinen pysyvä kirjanpito, jotta palautuminen ei aiheuta päällekkäisiä julkaisuja, maksuja, muutoksia tai muita sivuvaikutuksia.

Tämän kerroksen toimintaa pitää pystyä testaamaan myös silloin, kun prosessi kuolee juuri ulkoisen toiminnon ja paikallisen kuittauksen välissä.

---

# Kehityspolku VI: monirealminen yhteistyö

## Monirealmiin ei tarvita yhtä maailmanlaajuista agenttitiimiä

Realmit voivat olla itsenäisiä.

Development-realmilla voi olla omat agentit, muistilähteet ja työt. Production-realmilla omansa.

Sama agentti ei välttämättä kuulu molempiin.

Yhteistyö voi tapahtua edustajan, viestinvälityksen tai väliaikaisen keskustelutilan kautta.

Mutta mitään näistä malleista ei tarvitse tehdä etukäteen pakolliseksi.

## Ensimmäinen multirealm-kokeilu on täydellinen eristys

Kaksi realmia perustetaan samalla Entropi-instanssilla.

Niiden identiteetit, jäsenyydet, keskustelut, muistilähteet ja työkalut ovat erilliset.

Testataan, että toinen realm ei voi lukea, muuttaa tai päätellä toisen yksityisiä tietoja luvattomasti.

Tämä pitää varmistaa myös agenttien käyttämissä työkaluissa ja RAG-hauissa, ei vain HTTP API:ssa.

## Sen jälkeen kokeillaan siltaa

Silta voi aluksi olla vain valtuutettu viestinvälitys.

Lähderealmin toimija julkaisee rajatun tietopaketin. Se sisältää sallitut havainnot ja tarvittavat lähdeviitteet, mutta ei anna vastaanottajalle pääsyä koko lähtörealmin muistiin.

Vastaanottava realm käsittelee viestin omilla valtuuksillaan.

Spokesperson on tämän päälle mahdollinen toimintatapa. Samoin väliaikainen virtuaalitiimi.

Näitä kannattaa vertailla simulaatioissa.

Jos yksinkertainen valtuutettu viestinvälitys riittää, monimutkaisempaa tiimien välistä protokollaa ei tarvita.

---

# Kehityspolku VII: Entropin oma ylläpitorealm

Tämä on pitkän aikavälin kiinnostavin tavoite.

## Ylläpitorealm muodostetaan tavallisista osallistujista

Realmin nimi voisi olla esimerkiksi `entropi-maintenance`.

Sen toimijoilla olisi pääsy Entropin lähdekoodiin, testituloksiin, aiempiin kokeisiin, dokumentaatioon ja järjestelmän toiminnasta kerättyyn aineistoon.

Se voisi sisältää syvän domain-muistin agentin, kehitystyötä suorittavan agentin ja toimijoita, jotka tarkastelevat turvallisuutta, luotettavuutta tai suorituskykyä.

Näitä rooleja ei tarvitse pakottaa. Realm voisi kokeilla myös muita kokoonpanoja.

Ylläpitorealmin pitäisi pystyä käynnistämään uusia simulaatioita, muuttamaan testattavaa koodia ja vertaamaan tuloksia aikaisempiin versioihin.

Sen ei kuitenkaan pidä olla ainoa taho, joka päättää uuden Entropi-version turvallisuudesta.

## Itsekehityksen ensimmäinen kierros

Aluksi agentit tekevät muutoksia omaan koodirepositorion haaraansa.

Ne voivat ajaa testejä, luoda uusia testitapauksia, käyttää simulointeja ja arvioida tuloksia.

Jos muutos ei paranna toimintaa, se hylätään.

Jos muutos näyttää hyödylliseltä, agentit voivat rakentaa uuden Entropi-version eristettyyn ympäristöön.

Tässä vaiheessa mitään ei vielä julkaista tuotantoon.

Ensimmäinen tärkeä saavutus olisi, että Entropi pystyy itsenäisesti parantamaan omaa kokeellista toteutustaan useamman kehityskierroksen ajan.

## Ylläpitorealmin pitää kyetä jatkamaan kesken jäänyttä kehitystyötä

Kokeilun tulokset, avoimet kysymykset, koodimuutosten viittaukset ja perustelut tallennetaan pysyvään tilaan.

Jos ylläpitorealmin agentti kaatuu tai Entropi käynnistetään uudelleen, kehitystyö voidaan jatkaa.

Tämä erottaa pitkäikäisen itsekehityksen yksittäisestä agenttikutsusta, joka vain tekee yhden pull requestin.

OptChat voi auttaa ylläpitoagentteja muistamaan, mitä ne ovat kokeilleet. Varsinaiset muutokset, testitulokset ja julkaistut versiot pitää kuitenkin säilyttää myös rakenteisina tosiasioina.

---

# Kehityspolku VIII: itseään päivittävä Entropi

## Päivityksen on tapahduttava järjestelmän ulkopuolisen valvonnan kautta

Tämä on tärkein ero tavalliseen rekursiiviseen agenttiin.

Agentti voi kirjoittaa uuden Entropi-version. Se voi rakentaa sen, testata sitä ja ehdottaa käyttöönottoa.

Mutta tuotantoasennusta päivittävän ja tarvittaessa palauttavan mekanismin pitää toimia myös silloin, kun uusi Entropi on täysin rikki.

Sen vuoksi tarvitaan pieni riippumaton julkaisukontrolleri.

Se voi käyttää olemassa olevia Kubernetesin, GitOpsin ja progressiivisen julkaisun mekanismeja.

Julkaisukontrollerin tehtävänä on tarkistaa ulkopuoliset ehdot, suorittaa julkaisu hallitusti ja palauttaa edellinen versio, jos ehdot eivät täyty.

Agenttien ei pidä voida muuttaa näitä ehtoja saman muutoksen yhteydessä, jonka turvallisuutta niillä mitataan.

## Päivitys etenee vähitellen

Ensimmäinen taso on pelkkä koodin muokkaaminen ja testien ajaminen.

Toisella tasolla Entropi rakentaa itsestään uuden version ja käynnistää sen täysin eristetyssä ympäristössä.

Kolmannella tasolla uusi versio saa avata kopion vanhasta pysyvästä tilasta. Näin voidaan testata, että agenttien keskustelut, muisti, työt ja päätökset säilyvät versionvaihdossa.

Neljännellä tasolla uusi versio voidaan julkaista stagingiin ja myöhemmin rajattuun canary-ympäristöön.

Viidennellä tasolla voidaan sallia automaattinen tuotantopäivitys ennalta hyväksytyissä muutostyypeissä.

Jokaisella tasolla järjestelmä kerää todistusaineiston, jonka perusteella seuraavan tason käyttöoikeus voidaan myöntää.

Täysin unattended-toiminta ei siis tarkoita rajatonta oikeutta muuttaa mitä tahansa.

Se tarkoittaa, että sallittu toimintaluokka voi edetä itsenäisesti ilman ihmisen osallistumista jokaiseen yksittäiseen vaiheeseen.

## Muistin säilyminen on erillinen vaatimus

Entropin pitää voida vaihtaa suoritettava koodi menettämättä agenttien identiteettiä, keskusteluhistoriaa tai työn tilaa.

Nykyisessä toteutuksessa tilaa on erillisissä SQLite-tiedostoissa: core, Pi, OptChat ja sandboxien rekisteri.

Tämä on hyödyllinen lähtökohta, mutta turvallinen päivitys tarvitsee muutakin kuin pysyvän datavolyymin.

Päivitystä varten pitää tuntea eri tietovarastojen versiot ja keskinäinen yhteensopivuus.

Ennen pysyvän tilan muuttamista pitää luoda johdonmukainen snapshot.

Uuden version pitää pystyä testaamaan migraatioita snapshotilla ennen tuotantotilan avaamista.

OptChatin johdettu muisti voidaan tarvittaessa rakentaa uudelleen, mutta Pi-transkriptit ja coren auktoritatiivinen tila pitää säilyttää.

Vanhaa versiota ei saa käynnistää suoraan uuden version muuttamaan tietokantaan, jos yhteensopivuutta ei ole varmistettu.

## Palautus ei ole vain vanhan konttikuvan palauttamista

Jos uusi versio on muuttanut tietokantaskeemaa, vanha versio ei välttämättä osaa lukea sitä.

Siksi on suosittava vähitellen yhteensopivia migraatioita, kuten ensin uusien kenttien lisäämistä ja vasta myöhemmin vanhojen poistamista.

Rikkoutuneen päivityksen jälkeen pitäisi ensisijaisesti voida palata aiempaan toimivaan versioon ilman datan menettämistä.

Jos täysi palautus snapshotista on tarpeen, on ratkaistava myös, mitä päivityksen jälkeen hyväksytyille töille ja ulkoisille sivuvaikutuksille tapahtuu.

Tässä tarvitaan tarkka palautus- ja täsmäytysmenettely. Ulkoisessa järjestelmässä jo tehty muutos ei katoa sillä, että paikallinen tietokanta palautetaan.

## Ensimmäinen versionvaihdon koe

Käynnistetään Entropi versiolla A.

Agentille annetaan pitkä keskustelu, kesken jäävä tehtävä ja muistettava fakta.

Rakennetaan versio B. Se käynnistetään A:n tilasta tehdyllä kopiolla.

Varmistetaan, että agentti muistaa aikaisemman tiedon, näkee keskeneräisen työn ja pystyy jatkamaan sitä.

Sitten B:hen aiheutetaan tarkoituksellinen virhe.

Julkaisukontrollerin pitää palauttaa toimiva versio ja säilyttää mahdollisimman paljon hyväksyttyä tilaa.

Ennen onnistunutta testiä ei pidä olettaa, että muisti säilyy turvallisesti kaikkien päivitysten yli.

---

# Testausstrategia

Entropin kannalta testaus ei ole pelkkä laadunvarmistusvaihe. Se on myös keino selvittää, millainen arkkitehtuuri kannattaa rakentaa.

## Kolme testauksen tasoa

**Deterministiset invarianttitestit** tarkistavat asioita, joiden pitää aina pitää paikkansa.

Näitä ovat oikeudet, eristys, päätösten yksikäsitteisyys, delegointirajat, idempotenssi, tilamuutokset ja palautuminen.

**Simulaatiot** testaavat erilaisten toimintatapojen vaikutusta kokonaisen ongelman ratkaisemiseen.

Niissä voidaan verrata muistiratkaisuja, tiimirakenteita, delegointitapoja, ihmisen osallistumista ja rekursiivisia kokeilustrategioita.

**Todelliset integraatiokokeet** tarkistavat, että oikeat koodausagentit, mallit, ulkoiset järjestelmät ja julkaisuympäristöt käyttäytyvät riittävän hyvin.

Deterministisellä testillä voidaan todistaa, että tietty oikeusrikkomus estetään.

Simulaatiolla ei voida todistaa, että agenttitiimi ratkaisee aina vaikeat ongelmat. Sillä voidaan tuottaa näyttöä siitä, missä olosuhteissa jokin toimintamalli onnistuu muita paremmin.

## Erityisen tärkeät kokeet

Ensimmäinen on alkuperäinen TR-korjaus. Löytääkö dynaaminen yhteistyö laajemman ratkaisun kuin valmiiksi rajattu triage–implement–publish?

Toinen on aloitteellinen osallistuminen. Pystyvätkö agentit huomaamaan merkittävän ongelman ilman @mainintaa, kuitenkaan synnyttämättä loputtomia keskusteluketjuja?

Kolmas on syvämuisti. Löytääkö RAG- tai OptChat-agentti olennaisen aiemman havainnon ja osaako se kertoa tiedon alkuperän?

Neljäs on multirealm. Voivatko erilliset tiimit tehdä yhteistyötä ilman yhteistä muistia ja oikeuksien vuotamista?

Viides on rekursiivinen tutkimus. Parantaako alikokeiden käynnistäminen lopputulosta suhteessa käytettyihin resursseihin?

Kuudes on itsepäivitys. Pystyykö agenttien kehittämä uusi versio jatkamaan vanhasta tilasta, ja voidaanko epäonnistuminen palauttaa ilman hallinnan menetystä?

## Tuloksia pitää voida verrata ajan yli

Jokaiselle kokeelle tallennetaan käytetty Entropi-versio, konfiguraatio, mallit, muistilähteet, tapahtumat, kustannukset ja lopputuloksen arviointi.

Vertailukokeissa pidetään mahdollisimman moni muuttuja samana.

Esimerkiksi OptChatia ja RAGia verratessa ei samalla vaihdeta agenttimallia ja tiimin kokoonpanoa, ellei juuri niiden yhteisvaikutusta haluta tutkia.

Lupaavista tuloksista kannattaa tehdä toistettavia regressiotestejä.

Näin itseään kehittävä Entropi ei pelkästään muutu, vaan sille alkaa muodostua mitattavaa historiaa siitä, mitkä muutokset olivat hyödyllisiä.

---

# Suositeltu toteutusjärjestys

## Vaihe 1 — nykyisen ytimen vahvistaminen

Ensimmäisessä vaiheessa keskitytään aukkoihin, jotka voisivat vääristää myöhempiä kokeita.

Agentin työkalurajat pakotetaan teknisesti. Sandboxien jakamisen vaikutukset selvitetään. Hyväksyntöihin liittyvät yksityisyys- ja ajantasaisuustilanteet testataan.

Lisätään tarvittavat oikeus- ja kaatumistestit.

Nykyistä Pi-runtimea, SQLiteä tai OptChatia ei vaihdeta tässä vaiheessa.

**Tulos:** nykyinen core on luotettavampi perusta autonomisille kokeille.

## Vaihe 2 — ajonaikaisesti dynaamiset realmit

Realm-konfiguraation sovittaminen tehdään pysyväksi, idempotentiksi toiminnoksi.

Agentit, ihmiset, kanavat, muistilähteet ja valtuudet voidaan lisätä ja päivittää ilman sovelluskoodin muuttamista.

Yhden oletusrealmin oletukset poistetaan käynnistyksen, source-siltojen, routerin ja autentikoinnin ympäriltä.

Kokoonpanon muutoksille lisätään auditointi ja palautettava versiohistoria.

**Tulos:** sama Entropi-instanssi pystyy ajamaan erilaisia itsenäisiä realmeja.

## Vaihe 3 — ohjelmallinen osallistuminen ja keskusteluprotokolla

Nykyinen HTTP API ja tapahtumavirta tehdään riittävän kattaviksi, että ihminen tai agentti voi osallistua ilman demo-UI:ta.

Lisätään kunnollinen tapahtumatilaus, komentojen idempotenssi, tunnistautuneen osallistujan identiteetti ja mahdollisuus ohjata käynnissä olevaa toimintaa.

Ensimmäiseksi ulkoiseksi keskusteluprotokollaksi voidaan kokeilla Matrixia.

MCP:tä käytetään aluksi työkalujen ja tietolähteiden liittämiseen.

**Tulos:** ihminen ja agentti ovat samassa ympäristössä riippumatta käyttämästään ohjelmasta.

## Vaihe 4 — rekursiivinen simulaatioajuri

Rakennetaan nykyisten testien, FakeWorldin ja Pi-runtime-rajapintojen päälle simulaatioiden käynnistys- ja arviointikerros.

Kokeilut voivat luoda alikokeita, mutta niiden resurssit periytyvät vanhemmalta kokeelta.

Lisätään pysyvät tulokset, toistettavuus, vertailu ja pysäyttäminen.

Kokeillaan sekä kevyitä simuloituja maailmoja että eristettyjä kokonaisia Entropi-instansseja.

**Tulos:** agentit voivat itsenäisesti tutkia, millainen yhteistyö toimii.

## Vaihe 5 — pitkäaikainen domain-muisti

Lisätään vaihdettava muistilähdekerros ja ensimmäinen oikea RAG-adapteri.

Testataan samaa ongelmaa eri muistirakenteilla.

Muistille tehdään realm-kohtaiset käyttöoikeudet ja lähteiden alkuperän seuranta.

**Tulos:** erikoistunut agentti voi tarjota muulle tiimille laajaa domain-ymmärrystä.

## Vaihe 6 — todellinen koodaus- ja testausympäristö

Liitetään Git, koodaus-CLI:t, testit ja CI järjestelmään.

Agentit voivat tehdä oikeita koodimuutoksia eristetyissä työtiloissa ja arvioida niitä.

Kokeilut voidaan ajaa myös eri Entropi-versioilla.

**Tulos:** Entropi pystyy kehittämään omaa koodipohjaansa ilman, että muutoksia julkaistaan automaattisesti tuotantoon.

## Vaihe 7 — ylläpitorealm ja itsenäinen julkaisutestaus

Perustetaan pitkäikäinen ylläpitorealm.

Se saa oikeuden käynnistää simulaatioita, muuttaa koodia, rakentaa ehdokasversioita ja testata niiden yhteensopivuutta.

Lisätään riippumaton julkaisu- ja palautuskontrolleri.

**Tulos:** Entropi voi kehittää itseään ja käynnistää uusia versioita turvalliseen testiin.

## Vaihe 8 — rajattu unattended-itsepäivitys

Vasta kun aiemmat vaiheet ovat toimineet toistettavasti, sallitaan rajatut automaattiset julkaisut.

Julkaisuun liittyvät oikeudet, testiehdot, hyväksytyt muutostyypit ja resurssirajat määritellään ylläpitorealmin ulkopuolella.

Automaattinen rollback ja palautettavuus testataan oikeilla virhetilanteilla.

**Tulos:** Entropi pystyy päivittämään itseään hallituissa rajoissa ja jatkamaan toimintaansa versionvaihdon yli.

---

# Mitä ei kannata vielä rakentaa?

Tässä vaiheessa jättäisin pois suuren uuden UI:n, oman workflow-kielen, yleisen organisaatiohierarkian, pysyvät virtuaalitiimientiteetit, pakollisen spokesperson-mallin, itse rakennetun vektoritietokannan ja monimutkaisen mikropalveluarkkitehtuurin.

En myöskään vaihtaisi SQLiteä tai Pi Durablea vain siksi, että tulevaisuudessa voisi tarvita useita solmuja.

Niillä voi jatkaa kokeellista kehitystä, kunhan nykyisen yhden omistajaprosessin rajat ymmärretään.

Monisolmuiseen käyttöön kannattaa siirtyä vasta kun tiedetään, onko ongelmana suorituksen hajautus, tallennuksen saatavuus, resurssien määrä vai jokin muu.

Samoin realminvälistä federation-protokollaa ei tarvitse rakentaa ennen kuin kahden eristetyn realmin yhteistyö on testattu yksinkertaisella sillalla.

Tärkeintä on välttää tilannetta, jossa Entropi kasvaa isoksi malliksi kaikista mahdollisista organisaatioista ennen kuin yhtäkään niistä on osoitettu hyödylliseksi.

---

# Ensimmäinen konkreettinen kokonaisuus: Entropi Lab

Jos tästä pitäisi valita yksi seuraava toteutuskokonaisuus, valitsisin **Entropi Labin**.

Se ei olisi uusi tuote Entropin rinnalla, vaan nykyisen järjestelmän päälle tuleva kokeiluympäristö.

Siinä voisi:

- luoda realm-konfiguraatiosta eristetyn kokeilumaailman
- liittää siihen scriptattuja tai oikeita Pi-agentteja
- antaa ongelman ihmiseltä tai toiselta agentilta
- ajaa yhteistyötä ilman kiinteää workflow'ta
- muodostaa uusia alikokeita
- mitata niiden tulokset ja kustannukset
- tallentaa havainnot pysyvään historiaan
- verrata tuloksia aikaisempiin kokeisiin
- pysäyttää koko rekursiivisen kokeiluketjun turvallisesti

Ensimmäiseksi käyttäisin siinä kahta tilannetta.

Toinen olisi nykyinen Kubernetes-demomaailma, jossa tiedetään oikea ongelma ja sen ratkaisu.

Toinen olisi realistinen TR-korjaus, jossa alkuperäinen ehdotus on tarkoituksella liian suppea.

Näillä nähtäisiin nopeasti, milloin dynaaminen yhteistyö tuo lisäarvoa ja milloin se vain lisää keskustelua.

Kun tämä toimii, sama Lab voidaan antaa ylläpitorealmin käyttöön.

Silloin agentit voisivat itse muodostaa uusia kokeita Entropin kehittämiseksi.

Se olisi ensimmäinen todellinen askel kohti rekursiivista itsekehitystä.

---

# Päivityspolku nykyisestä koodista

Nykyistä toteutusta ei kannata korvata yhdellä suurella uudelleenkirjoituksella.

Muutokset voidaan tehdä suhteellisen pieninä jatkeina olemassa oleviin rajoihin.

`src/core/` säilyy toimintaytimenä. Sen rooleihin ja valtuuksiin lisätään tarvittavat tarkistukset, mutta agenttien domain-logiikkaa ei viedä sinne.

`src/seed.ts` kehittyy alustavasta datan lataamisesta hallituksi konfiguraation sovitusmekanismiksi.

`src/entropi.ts` muuttuu yhden käynnistysrealmin kokoonpanosta useita realmeja hallitsevaksi koontikerrokseksi.

`src/http/` tarjoaa toiminnan ja tapahtumien vakaan rajapinnan kaikille asiakkaille.

`src/adapters/pi/` säilyttää nykyisen Pi Durable -integraation ja saa tarvittaessa paremmat agenttikohtaiset kyky- ja muistiprofiilit.

`src/memory/` jatkaa OptChatin toteuttamista. RAG ja muut muistimuodot lisätään sen rinnalle adaptereina.

`src/runtime/` saa kokeilujen elinkaaren ja ulkoisen suoritusympäristön hallinnan, mutta varsinaiset simulaatiopolitiikat pysyvät coren ulkopuolella.

`src/adapters/` laajenee todellisiin kehitys-, testaus-, keskustelu- ja julkaisuintegraatioihin.

`test/` kasvaa yksittäisistä sääntö- ja palautumistesteistä kokonaisiin, toistettaviin simulaatioskenaarioihin.

Julkaisukontrolleri kannattaa toteuttaa erillisenä, mahdollisimman pienenä komponenttina.

Tärkeä periaate on, että jokainen nykyinen pysyvä tietomuoto ja julkinen rajapinta säilyy yhteensopivana tai saa hallitun migraation.

Pi Durablen päivityksiä ei pidä yhdistää samalla kertaa useisiin muihin kriittisiin arkkitehtuurimuutoksiin. Sen tallennusformaatin ja toiminnan yhteensopivuus on testattava erikseen.

---

# Mistä tietää, että Entropi kehittyy oikeaan suuntaan?

Pelkkä uusien ominaisuuksien määrä ei kerro mitään.

Parempia mittareita olisivat:

Kuinka paljon uusia käyttötilanteita pystytään toteuttamaan muuttamatta corea?

Kuinka usein agenttien yhteistyö löytää jotain, mitä yksittäinen agentti tai kiinteä workflow ei löydä?

Kuinka hyvin ihminen pystyy ymmärtämään ja ohjaamaan toimintaa osallistumatta jokaiseen vaiheeseen?

Kuinka paljon tietoa katoaa agenttien välisessä työnsiirrossa?

Miten muistiratkaisut vaikuttavat tulosten laatuun ja kustannuksiin?

Kuinka paljon uusia kokeiluja järjestelmä pystyy suorittamaan itsenäisesti ilman, että sen budjetti tai turvallisuusrajat rikkoutuvat?

Pystyykö uusi Entropi-versio jatkamaan vanhan version töitä ja muistia?

Kuinka usein autonominen muutos parantaa mitattavaa lopputulosta verrattuna lähtöversioon?

Ja lopulta: pystyykö järjestelmä tunnistamaan oman muutoksensa epäonnistuneeksi ja palauttamaan toimivan version ilman ihmisen apua?

Jos näissä tapahtuu kehitystä, Entropi on menossa kiinnostavaan suuntaan.

Jos järjestelmä vain tuottaa enemmän agentteja, enemmän viestejä ja enemmän abstraktioita, mutta ratkaisut eivät parane, se kasvaa väärään suuntaan.

---

# Lopullinen ajatus

Entropin vahvuus voisi olla se, ettei se yritä tietää etukäteen, miten digitaalinen tiimi toimii.

Se antaa toimijoille mahdollisuuden muodostaa yhteistyötä, käyttää erilaisia muistiratkaisuja ja edetä tilanteen mukaan.

Ihmiset pysyvät osallisina samoissa keskusteluissa ja samassa toimintaympäristössä. He voivat antaa valtuuksia, puuttua tekemiseen ja ohjata yhteistyötä, mutta heidän ei tarvitse määritellä jokaista vaihetta.

Simulaatioiden avulla voidaan kokeilla erilaisia tiimejä, hierarkioita, muistimalleja ja yhteistyötapoja ennen kuin niistä tehdään pysyviä rakenteita.

Kun simulaatioympäristö on riittävän luotettava, sama mekanismi voi tehdä todellisia kehitystehtäviä.

Kun todellisten tehtävien suoritus on riittävän luotettavaa, Entropi voi alkaa kehittää myös omaa toteutustaan.

Kun versionvaihdon jatkuvuus, turvallisuus ja palautuminen on osoitettu, rajattuja päivityksiä voidaan tehdä täysin itsenäisesti.

**Entropin ei siis tarvitse alkaa itseään kehittävänä järjestelmänä. Sen pitää ensin muuttua ympäristöksi, jossa itsekehitys on mahdollinen, mitattava ja hallittava toimintatapa.**

Siksi rakentaisin seuraavaksi rekursiivisen Entropi Labin dynaamisen, tiukan coren päälle — en uutta monimutkaisempaa AgentOS:ää.

Ja antaisin sen kokeiden osoittaa, millainen Entropista lopulta kannattaa tulla.</WritingBlock>

Suunnitelma perustuu [Entropin nykyiseen repositorioon](https://github.com/taituo/entropi) ja seuraavien olemassa olevien ratkaisujen mahdollisuuksiin: Matrixin avoimet keskustelu- ja tapahtumarajapinnat, A2A:n agenttienvälinen yhteistyö, MCP:n työkalurajapinnat, AG-UI:n ihmisen osallistuminen sekä autoresearch-tyyppinen iteratiivinen agenttitutkimus. <Cite refs={["turn534380search0","turn455441search2","turn455441search4","turn455441search5","turn455441search0"]}/>

**Tärkein priorisointipäätös:** en lähtisi ensimmäiseksi rakentamaan itseään päivittävää tuotanto-Entropia. Rakentaisin ensin ympäristön, jossa Entropi pystyy autonomisesti luomaan ja vertaamaan omia kokeellisia versioitaan. Siinä on jo riittävän suuri ja mielenkiintoinen tavoite seuraavalle kehitysvaiheelle.

## You

<!-- 2026-10-09T08:35:45.685Z -->

fine, nyt uskallan näyttää tämän [https://github.com/taituo/crewpi](https://github.com/taituo/crewpi)

## ChatGPT

<!-- 2026-10-09T08:35:55.013Z -->

No nyt kiinnostaa. 😄 Käyn CrewPin kunnolla läpi ja katson erityisesti, miten se liittyy Entropiin ja siihen rekursiiviseen, itseään kehittävään ympäristöön, jota juuri hahmottelimme. En oleta vielä, että toinen on toisen korvaaja — katsotaan ensin, mitä koodi oikeasti tekee.

## ChatGPT

<!-- 2026-10-09T08:36:12.052Z -->

Oho. 😄 **Nyt aika moni asia loksahti paikalleen.**

Luin CrewPin README:n, ja tämä muuttaa mun käsitystä Entropin syntyhistoriasta aika paljon.

**<Link url="https://github.com/taituo/crewpi" title="CrewPi"/> ei ole vain yksi aikaisempi agenttikokeilu. Se näyttää olevan jo toimivaksi rakennettu versio siitä digitaalisesta tiimistä, josta olet puhunut.**

Siellä on jo samassa järjestelmässä ihmiset, pitkäikäiset Pi Durable -agentit, agenttien välinen työnsiirto, hyväksynnät, Kubernetes-sandboxit, Keycloak, Temporal, OptChat-tyyppinen muisti ja oikea k3s-deploy.

Erityisen paljastava kohta on, että CrewPin incident-workflow tekee juuri tätä:

`diagnose → plan → human decision → execute → monitor → verify → close`

Eli **se kiinteä työnkulku, jonka rajoituksista olet kertonut, ei ole vain teoreettinen lähtökohta. Olet rakentanut sen ympärille kokonaisen toimivan järjestelmän.**

Ja nyt näyttää siltä, että Entropissa yrität säilyttää CrewPin toimivat mekanismit mutta vapauttaa itse yhteistyön siitä valmiiksi määritellystä prosessista.

Tämä on paljon kiinnostavampi kehityskaari kuin pelkästään uuden AgentOS:n rakentaminen.

Ja sitten löytyi vielä isompi yllätys.

CrewPissä on [8.10.2026 päivätty, 1 175-rivinen kehityssuunnitelma](https://github.com/taituo/crewpi/blob/main/docs/CrewPi_Agentic_Operations_OS_toteutussuunnitelma_00-15.md): **Agentic Operations OS & Organization Digital Twin**.

Siinä käsitellään jo lähes kaikkia asioita, joihin päädyimme tässä keskustelussa: dynaamisia organisaatioita, useita realmeja, valtuutettuja edustajia, ihmisten osallistumista, MCP:tä, synteettisiä maailmoja, snapshotteja, vaihtoehtoisia aikajanoja ja organisaatioiden häiriönsietokyvyn testausta.

Erityisesti yksi ajatus pisti silmään: simulaation *todellinen tila* ja agenttien *uskomukset siitä tilasta* pitää erottaa. Silloin voi tutkia, miten puutteellinen tai väärä tieto leviää tiimissä.

Se on syvällisempi simulaatioajatus kuin pelkkä agenttien suorituskyvyn vertailu.

Tärkeä erottelu kuitenkin: **suunnitelma ei tarkoita toteutusta**. CrewPin README kertoo, mitkä ominaisuudet toimivat, ja pitkä dokumentti kertoo, mitä oli tarkoitus rakentaa seuraavaksi.

Mutta nyt ymmärrän paremmin myös Entropin suunnan. CrewPin dokumentissa organisaatiomallista oli kasvamassa aika laaja kokonaisuus. Entropissa olet tehnyt päinvastaisen liikkeen: pienempi, tiukempi core, jonka päälle erilaisia organisaatioita ja simulaatioita voisi kokeilla ilman, että yksi malli lyödään lukkoon.

## Mitä CrewPi muuttaa Entropin kehityssuunnitelmassa?

Vertailisin näitä näin:

| | CrewPi | Entropi |
|---|---|---|
| **Lähtökohta** | Toimiva digitaalinen tiimi | Yleiskäyttöinen, headless toimintaydin |
| **Työn eteneminen** | Agenttien vapaa delegointi sekä kiinteät Temporal-workflow't | Työ, keskustelu ja päätökset ilman pakollista workflow'ta |
| **Ihmiset** | Keycloak, kanavat, hyväksynnät, UI | Realm-kohtainen actor- ja valtuusmalli, HTTP/SSE |
| **Muisti** | OptChat **ja agentin kanavien yli säilyvät muistiinpanot** | OptChat, eriytetty Pi-transkripteihin perustuva muisti |
| **Kokeiluympäristö** | K3s, sandboxit, todellisia operaatioita ja laaja demomaailma | Pienempi core, adapterit ja vahvempi palautumis- ja oikeustestaus |

Mulle löytyi kaksi erityisen merkittävää yksityiskohtaa.

**CrewPissä agentti voi jo itse perustaa uuden tapauskanavan.** [open_channel](https://github.com/taituo/crewpi/blob/main/src/tools.ts) tekee sen ilman, että ihmisen tarvitsee rakentaa keskustelutilaa valmiiksi. Se on pieni mutta todellinen esiaste itseorganisoituvalle tiimille.

**CrewPissä on myös jo agentin yhteinen pitkäaikainen muistikerros.** [memory.ts](https://github.com/taituo/crewpi/blob/main/src/memory.ts) erottaa kanavakohtaiset ja agentin laajuiset muistiinpanot sekä estää yksityisen keskustelun muistiinpanojen muuttumisen yhteisiksi.

Tämä on juuri se ominaisuus, jota pohdimme Entropin tulevaisuudeksi. Se on jo kokeiltu CrewPissä, vaikka varsinaista domain-RAGia ei vielä ole.

## Mitä tekisin nyt eri tavalla?

En enää ehdottaisi, että kaikki seuraavat ominaisuudet suunnitellaan Entropille tyhjästä.

**Käyttäisin CrewPitä toiminnallisena vertailukohtana ja Entropia uutena, paremmin rajattuna perustana.**

CrewPistä kannattaa ottaa talteen toimivat käyttäytymiset ja kokeet: agentin itsenäinen kanavan avaaminen, yhteinen muistikerros, oikeat kehitys- ja Kubernetes-tehtävät, ihmisen osallistuminen ja Temporalilla toteutettu incident-skenaario.

Mutta en siirtäisi koko CrewPin rakennetta Entropiin. Erityisesti en tekisi Temporalista pakollista yhteistyön ohjaajaa enkä toteuttaisi pitkän suunnitelmadokumentin kaikkia organisaatio-olioita.

Ja korjaan myös aiempaa Matrix-suositustani: kun olet jo tehnyt toimivan ihmisten ja agenttien keskusteluympäristön OIDC-kirjautumisella, uuden chat-protokollan käyttöönotto ei ole välttämättä ensimmäinen tehtävä. Ensin kannattaa tehdä nykyisestä osallistumismallista protokollariippumaton.

### Tärkein seuraava koe

Ottaisin CrewPin todellisen `checkout-api`-incidentin ja ajaisin sen Entropissa kahdella tavalla.

Ensimmäisessä käytetään alkuperäistä Temporal-workflow'ta. Toisessa agentit saavat muodostaa yhteistyönsä vapaasti samojen työkalujen, tiedon ja valtuuksien sisällä.

Sitten katsotaan, löytyykö riittävä ratkaisu, miten tieto liikkuu, paljonko ihmistä tarvitaan ja mikä molemmissa menee pieleen.

**Tällä olisi jo paljon suurempi todistusarvo kuin uudella demolla, jonka oikea lopputulos on rakennettu etukäteen.**

---

Mun käsitys on nyt tämä:

**CrewPi todisti, että digitaalisen tiimin voi saada oikeasti toimimaan. Entropi vaikuttaa yritykseltä löytää sen pienin yleiskäyttöinen ydin, jotta digitaalinen tiimi ei olisi enää yksi ennalta rakennettu organisaatio tai prosessi.**

Ja se 16 promptin suunnitelma kertoo, kuinka pitkälle olit jo vienyt ajatusta ennen tätä keskustelua. En väitä lukemani perusteella kaikkia suunnitelman ominaisuuksia toteutetuiksi, enkä ole ajanut CrewPin testejä.

Mutta nyt en enää ajattele, että Entropin seuraava tehtävä olisi keksiä digitaalinen tiimi.

**Sen seuraava tehtävä on selvittää kokeellisesti, kuinka paljon CrewPin rakenteesta voi jättää pois menettämättä niitä asioita, jotka saivat sen toimimaan.**

Se on aika paljon tarkempi ja kiinnostavampi tutkimuskysymys.

## You

<!-- 2026-10-09T08:47:54.891Z -->

en tiedä miten vaan jatkaisin, koska crewpi kasvoi, ja rakenisi liikaa siltaa temporaliin sen takia hajoautin sintten .. ja sitten halausin coren erilleen ja nyt on kaksi haaraa

sitten tuli "pari" ideaa

## ChatGPT

<!-- 2026-10-09T08:48:06.844Z -->

Musta alkaa näyttää siltä, että olet tullut aika luonnolliseen mutta hankalaan kohtaan projektissa: **jokainen ratkaistu ongelma on paljastanut uuden tason, jota alkuperäinen arkkitehtuuri ei oikein osannut kuvata.**

CrewPi kasvoi, koska halusit oikeasti toimivan digitaalisen tiimin. Temporal ratkaisi suorituksen jatkuvuutta, Pi Durable agenttien jatkuvuutta, ja niiden ympärille tarvittiin yhteistyötä, oikeuksia, muistia ja ihmisiä.

Mutta samalla CrewPi alkoi sitoa näitä asioita toisiinsa. Sitten erotit coren Entropiin.

Ja nyt kun rakenne on vihdoin yksinkertaisempi, huomaat, että sillä voisi tehdä paljon enemmän kuin alkuperäisellä CrewPillä.

Se selittää hyvin, miksi seuraava askel tuntuu vaikealta.

## Mä en yhdistäisi näitä kahta haaraa takaisin

Ainakaan vielä.

Ajattelisin niitä eri tarkoituksissa:

<box border radius="lg" padding={3} gap={3}>
  <row align="start" gap={3}>
    <icon name="boxes" color="secondary" size="lg"/>
    <box flex="1" gap={1}>
      **CrewPi — toimiva kokeilu ja vertailukohta**

      Siellä on oikeita integraatioita, Temporal-työnkulkuja, ihmiset, agentit ja muistiratkaisuja. Se näyttää, mitä kaikkea järjestelmällä pystyy tekemään.
    </box>
  </row>
  <divider color="subtle"/>
  <row align="start" gap={3}>
    <icon name="layers" color="secondary" size="lg"/>
    <box flex="1" gap={1}>
      **Entropi — yleiskäyttöinen perusta**

      Siellä selvitetään, mitkä mekanismit ovat todella välttämättömiä, jotta erilaiset yhteistyö- ja suoritusmallit toimivat luotettavasti.
    </box>
  </row>
  <divider color="subtle"/>
  <row align="start" gap={3}>
    <icon name="flask-conical" color="secondary" size="lg"/>
    <box flex="1" gap={1}>
      **Uudet ideat — kokeet, eivät vielä arkkitehtuuria**

      Niitä voidaan testata Entropin päällä ilman, että jokainen idea muuttuu uudeksi pysyväksi käsitteeksi coressa.
    </box>
  </row>
</box>

Ja tässä on yksi ero aiempaan suunnitelmaani: **en tekisi nyt edes multirealmia tai simulaattoria automaattisesti seuraavaksi isoksi toteutukseksi.**

Ennen sitä katsoisin, mitkä niistä uusista ideoista muuttavat koko järjestelmän suuntaa.

Koska me ollaan jo keskusteltu aika radikaalisti erilaisista mahdollisuuksista:

- Digitaalinen tiimi, jossa ihminen on tavallinen osallistuja.
- Eri realmeissa toimivat itsenäiset agenttiyhteisöt.
- Syvämuistiset agentit, jotka muodostavat kollektiivista asiantuntemusta.
- Rekursiiviset simulaatiot, joissa kokeet synnyttävät uusia kokeita.
- Entropi, joka pystyy kehittämään ja lopulta päivittämään itseään.

Nämä eivät välttämättä ole viisi erillistä ominaisuutta. **Niiden alta saattaa löytyä yksi yhteinen mekanismi**, jota et ole vielä tunnistanut.

Ja juuri sen löytäminen voisi olla tärkeämpää kuin seuraavan komponentin kirjoittaminen.

Temporalistakaan ei tarvitse luopua. Se voi olla erinomainen adapteri silloin, kun joku oikeasti tarvitsee määrämuotoisen, pitkäikäisen prosessin. Mutta sen ei tarvitse määritellä Entropin yleistä tapaa tehdä yhteistyötä.

Mä tekisin nyt yhden käytännön päätöksen: **älä yritä ratkaista CrewPin ja Entropin lopullista suhdetta vielä.** Pidä molemmat olemassa ja anna seuraavien kokeiden osoittaa, mitä kummastakin kannattaa säilyttää.

Ja niistä *"parista"* ideasta...

**Kerro ne vaan kaikki, vaikka ne olisivat keskenään ristiriitaisia, aivan keskeneräisiä tai muuttaisivat koko Entropin suunnan.** Ei tarvitse muotoilla niitä ominaisuuksiksi tai suunnitelmaksi.

Mua kiinnostaa tässä vaiheessa enemmän, mitä olet alkanut nähdä mahdollisena, kuin miten se pitäisi heti toteuttaa.

## You

<!-- 2026-10-09T08:49:54.150Z -->

ja tein loputtomasti okeiuaja ilman mallia, totesin siinä ei ole järkeä



totesin tarvisen oikean intentin



- jalkapallomaailma, agentit bettaavat ja keksustelevat, hakevat scout agentitellta teitao

koitatvat paperbetata uusia tuloksia vateen



tai pelin leaaminen



tai ohjelmistokehitys



workflown valvonta



tiimin osa virtualainen osa



away signaalit



ceo



jne



sitten huomana että tuo optchat kehitty aloin sitkin tekemään



nyt olen valmis ottamaan max tilausken vastaan ja alkaa kehittmän tätä polulla



Joka on kestävä

## ChatGPT

<!-- 2026-10-09T08:51:09.492Z -->

Nyt mä luulen ymmärtäväni, mikä sun kehityksessä on ollut se vaikein kohta.

**Sä olet rakentanut infrastruktuuria digitaalista tiimiä varten, mutta infrastruktuuri yksinään ei vielä kerro, pystyykö digitaalinen tiimi mihinkään hyödylliseen.**

Ja kun teit loputtomasti kokeiluja ilman oikeaa mallia, sait lopulta testattua lähinnä järjestelmän mekanismeja. Viestit kulkevat, delegointi toimii, tila säilyy, hyväksyntä odottaa.

Mutta ei vielä sitä, osaako tiimi ajatella, tutkia, oppia ja toimia.

Sitten tajusit tarvitsevasi **oikean intentin**. Jonkin, jonka lopputulosta ei voi käsikirjoittaa etukäteen.

Mun mielestä tämä on nyt se tärkein havainto koko projektissa.

## Oikea intentti muuttaa kaiken

Esimerkiksi jalkapallomaailma on yllättävän hyvä testikohde.

Ajatellaan, että joukko agentteja saa tehtäväksi seurata otteluita, pyytää scout-agentilta lisätietoa, keskustella havainnoistaan ja tehdä paperivetoja ennen otteluiden alkua.

Ottelun päätyttyä järjestelmä saa todellisen tuloksen.

Sitten agentit voivat tutkia, mikä meni oikein, mikä väärin ja mitä niiden pitäisi oppia.

<box border radius="xl" padding={3} gap={2}>
  <box background="surface-secondary" padding={3} radius="lg" gap={1}>
    **Oikea intentti**

    <text size="sm">Arvioikaa tulevat ottelut. Tallentakaa ennusteet ja perustelut ennen ottelua. Verratkaa niitä toteutuneisiin tuloksiin ja oppikaa historiasta.</text>
  </box>
  <row justify="center"><icon name="arrow-down" color="tertiary"/></row>
  <grid columns={2} gap={2}>
    <grid-item>
      <box border padding={3} radius="lg" gap={1}>
        **Vapaa yhteistyö**
        <text color="secondary" size="xs">Agentit kutsuvat scoutteja, keskustelevat ja tutkivat tietoa</text>
      </box>
    </grid-item>
    <grid-item>
      <box border padding={3} radius="lg" gap={1}>
        **Pysyvä muisti**
        <text color="secondary" size="xs">OptChat, aiemmat havainnot ja tarvittaessa RAG</text>
      </box>
    </grid-item>
  </grid>
  <row justify="center"><icon name="arrow-down" color="tertiary"/></row>
  <box border radius="lg" padding={3} gap={1}>
    **Ulkoinen todellisuus**

    <text color="secondary" size="sm">Ottelut pelataan. Ennusteet verrataan lukittuihin tuloksiin. Agentit eivät voi muuttaa jälkikäteen sitä, mitä ennustivat.</text>
  </box>
  <row justify="center"><icon name="arrow-down" color="tertiary"/></row>
  <box background="surface-secondary" padding={3} radius="lg" gap={1}>
    **Uusi oppimiskierros**

    <text size="sm">Mitä havaittiin, mitä jäi huomaamatta ja parantaako muistin käyttäminen seuraavia ennusteita?</text>
  </box>
</box>

Tämä on kokonaan eri asia kuin skriptattu simulaatio.

Agenttien pitää muodostaa omat johtopäätöksensä. Maailma antaa niille riippumattoman palautteen.

Sama periaate toimisi ohjelmistokehityksessä, pelin pelaamisessa, workflow'n valvonnassa tai virtuaalisen tiimin johtamisessa.

## Tästä mä tekisin kestävän kehityspolun

En tekisi enää yhtä suurta CrewPi-tyyppistä ominaisuuksien kasaamista. Etenisin neljän askeleen kautta.

<box gap={3}>
  <row align="start" gap={3}>
    <box background="surface-secondary" radius="lg" padding={2}><title size="lg" color="default" tabularNums>01</title></box>
    <box flex="1" gap={1}>
      **Yksi oikea maailma**

      Valitaan yksi käyttötapaus, jolla on todellinen syöte ja riippumaton lopputulos. Siinä käytetään oikeaa LLM:ää, ei scriptattua demoa. Aluksi ei tarvita multirealmia eikä autonomista deployta.
    </box>
  </row>
  <row align="start" gap={3}>
    <box background="surface-secondary" radius="lg" padding={2}><title size="lg" color="default" tabularNums>02</title></box>
    <box flex="1" gap={1}>
      **Pysyvä, oppiva tiimi**

      Agenttien keskustelut ja kokemukset säilyvät OptChatissa. Domain-tieto voidaan hakea RAGista. Agentit voivat kutsua muita osallistujia, mutta niiden ei tarvitse seurata määrättyä yhteistyöketjua. Todelliset tulokset kirjataan erilleen agenttien omista muistikuvista.
    </box>
  </row>
  <row align="start" gap={3}>
    <box background="surface-secondary" radius="lg" padding={2}><title size="lg" color="default" tabularNums>03</title></box>
    <box flex="1" gap={1}>
      **Sama mekanismi toiseen maailmaan**

      Kun ensimmäinen toimii, annetaan Entropille aivan eri intentti, esimerkiksi korjatkaa tämä ohjelmistovirhe. Jos toinen maailma vaatii vain uudet agentit, työkalut ja tietolähteet, coren yleiskäyttöisyydestä alkaa olla näyttöä.
    </box>
  </row>
  <row align="start" gap={3}>
    <box background="surface-secondary" radius="lg" padding={2}><title size="lg" color="default" tabularNums>04</title></box>
    <box flex="1" gap={1}>
      **Entropin oma ylläpitorealm**

      Vasta tämän jälkeen järjestelmä alkaa tutkia omia ongelmiaan, tehdä kehitysmuutoksia ja luoda uusia kokeita. Se voi lopulta julkaista rajattuja muutoksia itse, kun versionvaihdon, muistien ja palautumisen turvallisuus on osoitettu.
    </box>
  </row>
</box>

## En tekisi "intentistä" vielä uutta suurta käsitettä

Entropissa on jo `WorkItem`, jolla on tavoite ja tila.

Aluksi intentti voisi tarkoittaa yksinkertaisesti:

**Joku haluaa jotain saavutettavaksi, on olemassa tapa havaita edistyminen ja toimijoille on annettu rajat, joiden sisällä ne saavat yrittää.**

Esimerkiksi:

- Jalkapallo: ennustakaa, tallentakaa arviot ennen tuloksia ja vertailkaa toteumiin.
- Ohjelmistokehitys: korjatkaa ongelma niin, että hyväksymistestit menevät läpi eikä muu toiminta rikkoudu.
- Workflow'n valvonta: havaitaan poikkeamat ja korjataan ne sallituissa rajoissa.
- CEO / away: tiimi voi jatkaa sovittua toimintaa poissaolon aikana, mutta tietää, milloin ihminen täytyy kutsua takaisin.

Näissä intentti voi olla samaa yleistä muotoa, vaikka työ on täysin erilaista.

## Ja se Max-tilaus

Tässä kohtaa ymmärrän hyvin, miksi olet valmis investoimaan kunnolliseen malliin.

Mutta tekisin yhden eron:

**Max-tilaus antaa tehokkaamman työskentelyvälineen. Kestävyys tulee siitä, että kokeet eivät ole riippuvaisia yhdestä mallista, keskusteluikkunasta tai tilauksesta.**

Tallentaisin joka kokeilussa mallin tunnisteen, kustannuksen, tehdyt havainnot ja tuloksen. Lisäksi asettaisin agenttien itsenäiselle tekemiselle kulutusrajat. Näin voit vaihtaa myöhemmin paikalliseen malliin tai toiseen palveluun menettämättä oppimishistoriaa.

OptChatin kehittyminen sopii tähän erityisen hyvin. Mutta myös sen hyöty pitää saada näkyviin oikeissa tehtävissä: muistaako agentti olennaisen asian, käyttääkö se sitä oikein ja paraneeko lopputulos?

---

### Yksi asia, jonka haluaisin sun säilyttävän

CrewPi, Temporal-kokeilut ja mallittomat simulaatiot eivät olleet turhia. Niissä olet saanut selville paljon siitä, miten suoritus ja yhteistyö saadaan kestämään.

Mutta nyt ei tarvitse enää todistaa pelkästään, että mekanismi toimii.

**Nyt pitää todistaa, että sen sisällä voi syntyä todellista osaamista ja että osaaminen säilyy ajasta ja ohjelmistoversiosta toiseen.**

Mun ehdotus ensimmäiseksi seuraavaksi askeleeksi on siksi **yksi elävä Entropi-realm oikealla mallilla, oikealla intentillä, pysyvällä muistilla ja riippumattomasti mitattavalla palautteella**.

Itse asiassa jalkapallon paperivetomaailma olisi tähän erittäin kiinnostava ensimmäinen koe juuri siksi, että agentit eivät hallitse otteluiden tuloksia. Siihen saa aidon palautesilmukan ilman oikean rahan riskiä.

Sitten ohjelmistokehitys toiseksi maailmaksi. Ja jos molemmat toimivat samalla corella, olisin paljon vakuuttuneempi Entropin suunnasta kuin sadan uuden simulaatiotestin jälkeen.

**Tässä vaiheessa en enää rakentaisi lisää maailmoja etukäteen. Rakentaisin yhden, joka saa oikeasti elää.**

## You

<!-- 2026-10-09T08:53:13.691Z -->

malli ei tarvise olla edes super frontir malli osa tiimistä voi käyttä ulkopuosisa agentti esim ooneshotitna acpn yli tai kysä suunnitelijalata joka on opus/fable/astra malli ja tekevät itse,,, principal advisor kutsu ulos

hei max tilaus on tämän kehittäisene mulla on openai rajapintaa tajolal rarpeekis mutta siis iahn 
ehkä kehittämisene ei tarfise niin isoa mallia

## ChatGPT

<!-- 2026-10-09T08:53:30.719Z -->

Aivan, nyt tajusin. Mä sekoitin kaksi eri asiaa. 😄

**Max-tilaus on sulle Entropin kehittämistä varten**, ei suunnitelma siitä, millä mallilla Entropin omat agentit pyörivät. OpenAI:n API:a sulla on jo riittävästi käytettävissä.

Ja itse asiassa tuo toinen huomiosi on arkkitehtuurin kannalta vielä tärkeämpi:

**Entropin tiimin ei tarvitse koostua pelkästään pysyvistä agenteista eikä kaikkien tarvitse käyttää kallista huippumallia.**

Pysyvä tiimi voisi koostua suhteellisen kevyistä agenteista, joilla on oikea konteksti, pitkä muisti ja pääsy työkaluihin. Kun vastaan tulee jotain poikkeuksellisen vaikeaa, tiimi voi kutsua ulkopuolisen asiantuntijan kertaluonteisesti.

Esimerkiksi principal advisor voisi olla ulkopuolinen Opus-, Fable- tai Astra-tasoinen agentti, joka saa rajatun ongelman, tutkii sen ja palauttaa perustellun arvion.

Sen ei tarvitse liittyä pysyvästi realmiin, ylläpitää omaa muistia siellä tai ryhtyä johtamaan tiimiä.

**Ulkopuolinen asiantuntija on kyvykkyys, jota tiimi voi käyttää tarvittaessa — ei pakollinen organisaatiorooli.**

## ACP sopii juuri tähän

Tarkistin nykyisen <Link url="https://agentclientprotocol.com" title="Agent Client Protocolin"/>: se tukee agenttisessioiden luomista, promptaamista, tapahtumapäivityksiä ja suorituksen keskeyttämistä. ACP v2 on olemassa luonnoksena, mutta v1 on edelleen vakaa lähtökohta adapterin tekemiseen. <Cite refs={["turn773347search5","turn773347search9","turn773347search2"]}/>

Mä tekisin Entropiin tällaisen eron:

<box border radius="lg" padding={3} gap={2}>
  <box gap={1}>
    **Pysyvä agentti**

    <text color="secondary" size="sm">Oma identiteetti realmissa, Pi Durable -keskustelu, OptChat-muisti, tehtävät ja jatkuvuus.</text>
  </box>
  <divider color="subtle"/>
  <box gap={1}>
    **Ulkopuolinen asiantuntija**

    <text color="secondary" size="sm">Kutsutaan ACP:n tai muun adapterin kautta tiettyyn ongelmaan. Voi käyttää eri mallia tai kokonaista koodausagenttia. Sen lausunto tallennetaan Entropiin, mutta sen omaa sessiota ei tarvitse ylläpitää pysyvästi.</text>
  </box>
  <divider color="subtle"/>
  <box gap={1}>
    **Ihminen**

    <text color="secondary" size="sm">Osallistuu samaan työhön, voi pyytää neuvoa tai antaa toimivaltansa mukaisen päätöksen. Ei erillinen workflow'n ulkopuolinen hyväksyntälaatikko.</text>
  </box>
</box>

Käytännössä tapahtuma voisi mennä näin:

> Development-realmin agentti huomaa arkkitehtuuriongelman, jota se ei osaa ratkaista luotettavasti.
>
> Se kutsuu ulkoisen principal advisorin, antaa tälle rajatun lähdekoodin ja ongelman kuvauksen.
>
> Advisor palauttaa vaihtoehdot, riskit ja suosituksensa.
>
> Tiimi keskustelee tuloksesta, tarkistaa väitteet ja päättää itse seuraavan askeleen.

Ulkopuolisen asiantuntijan mielipide ei automaattisesti saa päätösvaltaa. Sen ei myöskään tarvitse tietää koko realmin historiaa. Entropi huolehtii siitä, että konsultaatioon annetaan vain sallittu konteksti.

## Entä Entropin kehittäminen?

Siihen en tekisi isosta mallista oletusvaatimusta.

Tämä projekti tarvitsee ennen kaikkea kurinalaista iterointia: pieni muutos, todellinen testi, tuloksen tarkastelu, tarvittaessa korjaus. Keskikokoinenkin koodausmalli voi tehdä paljon, jos sillä on hyvä testikehikko ja oikea palaute.

Kalliimpaa ja vahvempaa mallia käyttäisin valikoivasti tilanteissa, joissa tarvitaan laajaa arkkitehtuurin arviointia, hankalan virheen tutkimista tai turvallisuusrajojen kriittistä tarkistamista. Max-tilaus voi olla hyödyllinen kehitystyön väline, mutta se ei ole edellytys tämän arkkitehtuurin toteuttamiselle.

**Ja tämä muuttaa kehityssuunnitelmaa taas vähän:** ensimmäinen tavoite ei välttämättä ole valtava, syvämuistinen agenttitiimi.

Se voisi olla **pieni pysyvä tiimi, joka osaa hankkia tarvittaessa lisää osaamista ulkopuolelta ja säilyttää hankitun tiedon**.

Silloin ajan myötä kasvava älykkyys ei tarkoita, että jokaisen agentin mallia pitää kasvattaa. Se voi tarkoittaa, että tiimi oppii, milloin kysyä, keneltä kysyä ja miten saamansa tieto kannattaa käyttää.

Ja se on hyvin lähellä sitä, miten oikea hyvä tiimi toimii.

## You

<!-- 2026-10-09T08:54:28.270Z -->

ja UI on aina mielenkiintoien, mutta periateessa agentit kirjoitta aniin paljon että en 

cli oli vaan esimerkki etät koko homma voisi olla dataa, protokollaa

pi-durable ja kaikki pi osat kiinnsotaa

## ChatGPT

<!-- 2026-10-09T08:54:39.615Z -->

Joo — tuo tarkentaa suuntaa taas. En siis nostaisi CLI:tä enkä chattikäyttöliittymää Entropin pääarkkitehtuuriksi. Katson vielä Pi Durablen ja muiden Pi-osien roolit, koska niistä voi löytyä juuri oikea suorituskerros sellaisen data- ja protokollapohjaisen ympäristön alle, jossa agenttien viestimäärä ei hukuta ihmistä.

## ChatGPT

<!-- 2026-10-09T08:55:01.136Z -->

Jep. Nyt ymmärrän paremmin, mitä tarkoitat. 😄

**UI kiinnostaa sua kyllä, mutta et halua, että koko järjestelmä on sidottu siihen, miten ihmiselle näytetään agenttien keskustelu.** Agentit voivat tuottaa valtavasti tekstiä, eikä ihmisen välttämättä tarvitse lukea siitä kuin pieni osa.

Ja CLI oli vain esimerkki siitä, että kaiken pitäisi olla käytettävissä **datana ja protokollan kautta**.

Mun mielestä tässä on aika merkittävä oivallus Entropin arkkitehtuurin kannalta.

## Pi Durable saattaakin olla lähempänä etsimääsi perustaa kuin ensin ajattelin

Tutkin sen nykyistä dokumentaatiota tarkemmin. Siinä on jo yllättävän paljon niitä mekanismeja, joita olemme hahmotelleet Entropin tulevaisuudeksi.

| Pi-osa | Mitä se voisi tarjota Entropille |
|---|---|
| `pi-ai` | Eri mallien käyttäminen samalla rajapinnalla |
| `pi-durable` | Pysyvät keskustelut, työkalukutsut ja palautuvat tehtävät |
| `Chord` | Rakenteinen tila, muutostapahtumat ja sovelluskomponenttien yhdistäminen |
| Pi Durable extensions | Agenttikohtaiset työkalut, hookit, promptit ja omat pysyvät tehtävät |
| Pi Durable forks | Keskustelun haarautuminen kokeilua varten |
| Pi coding agent / ACP | Ulkoiset kertakäyttöiset koodaus- ja asiantuntija-agentit |

Pi Durable tukee jo keskustelun `fork()`-toimintoa, omia durable task -toteutuksia, rakenteisia dokumentteja sekä hookeja, joilla mallin ja työkalujen toimintaa voidaan ohjata. Lisäksi keskustelun tilasta saa sekä rakenteisen näkymän että tapahtumapäivityksiä. <Cite refs={["turn689727view0","turn763321search4"]}/>

Tämä saa mut ajattelemaan, ettei Entropiin ehkä tarvitse rakentaa niin suurta omaa runtime- tai simulaatiokoneistoa kuin aiemmin suunnittelimme.

**Voisit käyttää Pi Durablen omia rakenteita paljon syvemmin ja jättää Entropille vain sen, mikä on aidosti usean osallistujan ja realmin yhteistä.**

## Entropin protokollan ei tarvitsisi olla chat-protokolla

Ajatellaan, että agentti tekee ohjelmistokehitystä kaksi tuntia.

Se voi tuottaa satoja viestejä, työkalukutsuja ja välituloksia. Kaikki ne voivat säilyä Pi Durablen transkriptissa ja työtilassa.

Mutta Entropiin voisi kirjautua merkittäviä tapahtumia:

```text
work.created
agent.started
observation.recorded
delegation.requested
evidence.attached
work.blocked
decision.requested
work.completed
```

Nuo ovat esimerkkejä mahdollisesta laajennetusta tapahtumasanastosta, eivät kaikki nykyisiä Entropi-eventtejä.

Ihminen voisi nähdä samasta tekemisestä vain:

<box border radius="lg" padding={3} gap={3}>
  <row justify="between" align="center">
    **Development · Korjaa maksupalvelun virhe**
    <badge color="secondary">Työn alla</badge>
  </row>
  <row align="start" gap={2}>
    <icon name="check-circle-2" color="success"/>
    <box flex="1" gap={1}>
      **Ongelman syy tunnistettu**
      <text size="sm" color="secondary">3 havaintoa ja 2 lähdeviitettä</text>
    </box>
  </row>
  <row align="start" gap={2}>
    <icon name="check-circle-2" color="success"/>
    <box flex="1" gap={1}>
      **Korjausehdotus valmistunut**
      <text size="sm" color="secondary">Muutoksia 4 tiedostoon · testit ajettu</text>
    </box>
  </row>
  <row align="start" gap={2}>
    <icon name="message-circle" color="secondary"/>
    <box flex="1" gap={1}>
      **Reviewer ja developer keskustelevat**
      <text size="sm" color="secondary">Keskustelussa 27 viestiä — koko historia saatavilla</text>
    </box>
  </row>
  <divider color="subtle"/>
  <text color="secondary" size="sm">Ihmisen huomiota ei juuri nyt tarvita.</text>
</box>

Tämä on vain havainnollistus, mutta periaate olisi tärkeä:

**Raakakeskustelu on olemassa. Ihmisen näkymä on siitä johdettu tulkinta, ei koko tapahtumavirta sellaisenaan.**

Halutessaan ihminen voi avata keskustelun, yksittäisen työkalukutsun tai vanhan OptChat-muistin kohdan.

UI:ta ei siis tarvitse jättää pois. Siitä voi tulla paljon hyödyllisempi, kun sen ei tarvitse toimia ensisijaisesti valtavana chat-lokina.

## Yksi kiinnostava raja Pi Durablen ja Entropin välillä

<box border radius="xl" padding={3} gap={2}>
  <box border radius="lg" padding={3} gap={1}>
    **Entropi**

    <text color="secondary" size="sm">Realmit, identiteetit, jäsenyydet, valtuudet, yhteiset työt, päätökset, yhteistyö, auditointi ja tapahtumien pysyvä historia.</text>
  </box>
  <row justify="center"><icon name="arrow-down-up" color="tertiary"/></row>
  <box border radius="lg" padding={3} gap={1}>
    **Pi Durable + Chord**

    <text color="secondary" size="sm">Agentin sisäinen ajotila, pysyvät keskustelut, tehtävägraafit, työkalukutsut, forkkaus, konfigurointi ja rakenteisen tilan seuranta.</text>
  </box>
  <row justify="center"><icon name="arrow-down-up" color="tertiary"/></row>
  <box border radius="lg" padding={3} gap={1}>
    **Adapterit ja protokollat**

    <text color="secondary" size="sm">ACP-asiantuntijat, MCP-työkalut, ulkoiset keskustelukanavat, koodausympäristöt, simulaatiot ja todelliset järjestelmät.</text>
  </box>
</box>

Tässä on yksi tärkeä yksityiskohta: Pi Durablen `watch()` on näkymän päivitysmekanismi, ei koko historian toistoon tarkoitettu tapahtumaloki. Entropin oma pysyvä tapahtumaloki täydentää sitä, eikä näitä kahta kannata yhdistää huolimattomasti. <Cite refs={["turn763321search0","turn689727view0"]}/>

Ja Pi Durablen omat durable taskit voisivat olla kiinnostava tapa toteuttaa esimerkiksi ulkoisen asiantuntijan kutsuminen, pitkäkestoinen tutkimus tai kokeilun suorittaminen ilman, että jokaista tällaista toimintoa tarvitsee mallintaa uutena työnkulkumoottorina.

## Mitä tämä muuttaa seuraavassa kehitysvaiheessa?

Mä tekisin ennen suuren simulaatiokehyksen toteuttamista yhden pienen mutta syvällisen kokeen:

**Entropi-realm, jossa pysyvä Pi Durable -agentti voi kutsua ulkopuolista ACP-agenttia, tallentaa tämän tuloksen ja jatkaa omaa keskusteluaan sekä muistiaan.**

Siinä testattaisiin samalla:

- säilyykö pysyvän agentin oma konteksti
- miten ulkoisen asiantuntijan vastaus liitetään yhteiseen työhön
- mitä tapahtuu, jos prosessi kuolee kesken kutsun
- voiko ihminen seurata ja ohjata tekemistä ilman koko transkriptin lukemista

Ja sitten samaa rakennetta voisi käyttää rekursiivisen simulaation lapsikokeen käynnistämiseen.

Ehkä kiinnostavin kysymys ei olekaan enää, kuinka paljon Pi Durablen ympärille pitää rakentaa.

**Vaan kuinka vähän Entropin tarvitsee itse toteuttaa, jos Pi Durablen keskustelut, forkkaus, tehtävät ja Chordin rakenteinen tila otetaan kunnolla käyttöön.**

Tässä olisi varmasti tutkimisen arvoinen kohta, koska Pi Durable on edelleen hyvin uusi ja kokeellinen. Sen rajapintoihin kannattaa tehdä ohut adapteri, jotta Entropin pysyvä toimintamalli ei rikkoudu kirjastoversion mukana.

Ja nyt mulle tulee mieleen yksi kysymys sun suunnasta: **haluaisitko Entropin olevan ensisijaisesti Pi Durablen päälle rakennettu yhteistyöympäristö, vai edelleen runtime-riippumaton core, jonka vahvin oletustoteutus vain käyttää Pi:tä todella syvällisesti?**

Molemmat ovat mahdollisia, mutta juuri tuo valinta vaikuttaa aika paljon siihen, miten paljon omaa koodia kannattaa enää kirjoittaa.

## You

<!-- 2026-10-09T08:57:57.516Z -->

halaun vaan pitää yhdeyn pihin ja perustaa sihen, koska mulla ie ole kykyä kehittää sitä harneesia vaan keskittyä organisaatoihin

## ChatGPT

<!-- 2026-10-09T08:58:13.870Z -->

Nyt ymmärrän. Ja tämä selkeyttää Entropin suuntaa aika ratkaisevasti. 😄

**Et halua rakentaa uutta agenttiharnessia. Haluat rakentaa organisaatioiden toimintaympäristön Pi:n päälle.**

Se on myös hyvä rajaus sille, mihin oma kehitysaikasi kannattaa käyttää.

Olin aiemmin ehdottanut Entropille aika vahvaa runtime-riippumattomuutta. Mutta jos Pi on tietoinen teknologiavalinta, ei ole järkeä käyttää valtavasti energiaa siihen, että kaikki olisi vaihdettavissa johonkin kuvitteelliseen tulevaan harnessiin.

## Jakaisin vastuun näin

<box border radius="xl" padding={3} gap={2}>
  <box border radius="lg" padding={3} gap={1}>
    <row align="center" gap={2}>
      <icon name="users" color="secondary"/>
      **Entropi — organisaatiot ja yhteistyö**
    </row>
    <text size="sm" color="secondary">Realmit, ihmiset, agenttien jäsenyydet, kanavat, valtuudet, yhteiset tavoitteet, päätökset, tiedon jakaminen, yhteistyö ja simulaatiomaailmat.</text>
  </box>
  <row justify="center"><icon name="arrow-down-up" color="tertiary"/></row>
  <box border radius="lg" padding={3} gap={1}>
    <row align="center" gap={2}>
      <icon name="brain-circuit" color="secondary"/>
      **Pi-ekosysteemi — agenttien suoritus**
    </row>
    <text size="sm" color="secondary">Pi Durable, Pi AI, Chord, keskustelut, durable taskit, työkalut, mallien käyttäminen, forkkaus ja agentin suoritusmuistin jatkuvuus.</text>
  </box>
  <row justify="center"><icon name="arrow-down-up" color="tertiary"/></row>
  <box border radius="lg" padding={3} gap={1}>
    <row align="center" gap={2}>
      <icon name="plug" color="secondary"/>
      **Ulkoinen maailma**
    </row>
    <text size="sm" color="secondary">ACP-koodausagentit ja asiantuntijat, MCP-lähteet, ohjelmistokehitys, pelit, jalkapallodata, Kubernetes ja muut ympäristöt.</text>
  </box>
</box>

**Pi vastaa siitä, miten agentti elää. Entropi vastaa siitä, miten agentit ja ihmiset elävät yhdessä.**

Tuo olisi mulle koko projektin suunnittelusääntö.

## Mitä se tarkoittaisi käytännössä?

- En toteuttaisi omaa LLM-agenttisilmukkaa, keskustelun tiivistysmoottoria, malligatewayta tai yleistä durable task -moottoria.
- Käyttäisin Pi Durablen olemassa olevia mekanismeja mahdollisimman paljon ennen uusien suoritusabstraktioiden lisäämistä.
- Säilyttäisin Entropin nykyisen coren yhteisen organisaatiotilan ja oikeuksien omistajana. Sen outbox esimerkiksi ratkaisee eri ongelman kuin agentin sisäinen suoritus.
- Pitäisin Pi-integraation yhdessä selkeässä adapterissa, jotta Pi:n päivityksiä voi testata hallitusti. Sen ei kuitenkaan tarvitse olla yleinen, kaikkia kuviteltuja runtimeja tukeva framework.
- Kehittäisin ennen kaikkea sitä, miten organisaatiot syntyvät, muuttuvat, jakavat tietoa, tekevät päätöksiä ja voivat perustaa uusia kokeiluja.

Ja tärkeää: **Entropin ei tarvitse tietää, käyttääkö joku agentti pientä paikallista mallia, suurta pilvimallia vai ulkopuolista ACP-asiantuntijaa.** Sen pitää tietää, kuka kutsui kenet, mihin tarkoitukseen, mitä tietoa annettiin ja mitä seurauksia syntyi.

## Tämä muuttaa myös seuraavaa kehitysaskelta

En lähtisi ensimmäiseksi rakentamaan monimutkaista simulaattoria tai uutta protokollaa.

Rakentaisin yhden todella pienen organisaatiokokeen:

Ihminen perustaa realmin, johon kuuluu kaksi pysyvää Pi-agenttia. Niillä on omat muistinsa ja yhteinen keskustelutila. Toinen voi kutsua kertaluonteisen ulkopuolisen asiantuntijan. Agentit voivat perustaa uuden kokeilutilan, tehdä siellä havaintoja ja tuoda tuloksen takaisin.

Sen jälkeen koko järjestelmä käynnistetään uudelleen.

**Kaikki olennaiset suhteet, keskustelut, työt ja muistot säilyvät.**

Jos tuo toimii ilman uutta agenttiharnessia, ollaan oikealla polulla.

Ja CrewPi voidaan pitää edelleen vertailukohtana, jossa monet oikean maailman käyttötapaukset ovat jo olemassa.

Mulle tästä muodostuu nyt hyvin yksinkertainen projektin identiteetti:

> **Entropi on Pi:n päälle rakennettu ympäristö, jossa ihmiset ja pitkäikäiset agentit voivat muodostaa, käyttää ja kehittää organisaatioita — myös virtuaalisia ja rekursiivisesti syntyviä.**

Se on mielestäni paljon parempi rajaus kuin yrittää tehdä yhtä aikaa oma Pi Durable, oma Temporal, oma Slack, oma simulaattori ja oma AgentOS.

Sinun varsinainen tutkimuskohteesi on **organisoituva yhteistyö**. Pitäisin fokuksen siinä.

## You

<!-- 2026-10-09T09:03:30.358Z -->

miten voisin parantaa tuota komnunikaaitota, huomasin että liikaa kanavia on yllättän ongelma ja kanavat jossa ei ole ole kaikki, myös case on aika tärkeä, ja sinne se memonote toi apuja crewpi puolela

## ChatGPT

<!-- 2026-10-09T09:03:37.774Z -->

Tuo on minusta juuri oikea kohta tutkia Entropia seuraavaksi: kanavien määrä ei vain lisää viestejä, vaan hajottaa yhteisen tilannekuvan. Katson CrewPin case-, memo- ja delegointitoteutuksia sekä Entropin nykyistä viestimallia, ja ehdotan mahdollisimman pientä muutosta, joka ei pakota kaikkia agentteja samaan kanavaan.

## ChatGPT

<!-- 2026-10-09T09:05:03.506Z -->

Mä luulen, että olet löytänyt yhden Entropin keskeisimmistä ongelmista.

**Kanavat ratkaisevat sen, missä keskustellaan. Ne eivät ratkaise sitä, miten tiimi muodostaa yhteisen käsityksen tilanteesta.**

Ja mitä enemmän kanavia syntyy, sitä pahemmaksi ero muuttuu.

CrewPissä `memo_note` auttoi, koska se antoi agentille keinon viedä tietoa keskustelusta toiseen. Mutta se ratkaisi vasta osan ongelmasta.

## Mitä nykyisessä rakenteessa tapahtuu?

Kävin koodia katsomassa, ja siellä on kolme kiinnostavaa yksityiskohtaa.

1. **CrewPin uusi case-kanava saa oletuksena kaikki agentit**, jos osallistujia ei erikseen anneta. Tämä löytyy [channels.ts](https://github.com/taituo/crewpi/blob/main/src/channels.ts)-tiedostosta. Se helpottaa yhteistyötä, mutta lisää helposti agenttien ja keskustelujen määrää.

2. **Entropissa `ask_agent` toimii vain saman spacen sisällä.** Jos tarvittava asiantuntija ei ole paikalla, sitä ei voi kutsua normaalilla delegoinnilla. Tämä löytyy [tools.ts](https://github.com/taituo/entropi/blob/master/src/adapters/pi/tools.ts)- ja [core.ts](https://github.com/taituo/entropi/blob/master/src/core/core.ts)-toteutuksista.

3. **Pi Durablen keskustelu on edelleen agenttikohtainen ja kanavakohtainen.** Vaikka kaksi agenttia ovat saman kanavan jäseniä, toisen agentin keskusteluhistoria ei automaattisesti ole toisen mallikontekstissa.

Eli ongelma ei ratkea edes laittamalla kaikki agentit samaan kanavaan.

**Yhteinen kanava ei vielä tarkoita yhteistä muistia.**

## Mä kokeilisin case-keskeistä kommunikaatiota

En poistaisi kanavia. Enkä tekisi kaikkia agentteja kaikkien kanavien jäseniksi.

Muuttaisin sen, mikä on yhteistyön keskipiste.

<box border radius="xl" padding={3} gap={2}>
  <box background="surface-secondary" radius="lg" padding={3} gap={1}>
    <row align="center" gap={2}>
      <icon name="folder-open" color="secondary"/>
      **Case: checkout-api kaatuu**
    </row>
    <text size="sm">Yhteinen tilannekuva: tavoite, havainnot, lähteet, keskeneräiset kysymykset, päätökset ja tulokset.</text>
  </box>
  <row justify="center"><icon name="arrow-down-up" color="tertiary"/></row>
  <grid columns={2} gap={2}>
    <grid-item>
      <box border radius="lg" padding={3} gap={1}>
        **#production**

        <text color="secondary" size="xs">Ops tutkii lokit ja Kubernetesin</text>
      </box>
    </grid-item>
    <grid-item>
      <box border radius="lg" padding={3} gap={1}>
        **#development**

        <text color="secondary" size="xs">Developer tutkii koodin ja testit</text>
      </box>
    </grid-item>
    <grid-item>
      <box border radius="lg" padding={3} gap={1}>
        **Principal advisor**

        <text color="secondary" size="xs">Ulkopuolinen ACP-konsultaatio tarvittaessa</text>
      </box>
    </grid-item>
    <grid-item>
      <box border radius="lg" padding={3} gap={1}>
        **Ihminen**

        <text color="secondary" size="xs">Näkee tilanteen ja osallistuu tarvittaessa</text>
      </box>
    </grid-item>
  </grid>
</box>

Case olisi siis yhteinen asia, jonka parissa työskennellään. Kanava olisi yksi tapa keskustella siitä.

Jos agentti työskentelee eri kanavassa, sen ei tarvitse tietää kaikkea muiden keskusteluista. Sen pitää saada riittävä, ajantasainen ja valtuutettu tieto **kyseisestä casesta**.

Tätä varten en välttämättä tekisi vielä uutta `Case`-domain-oliota. Entropissa on jo `Space(kind=case)`, `WorkItem`, tapahtumaloki ja ulkoiset viittaukset. Niistä voi koostaa ensimmäisen version.

## CrewPin `memo_note` on tässä todella arvokas

Mutta veisin sitä vähän pidemmälle.

CrewPin [memory.ts](https://github.com/taituo/crewpi/blob/main/src/memory.ts) antaa jo tallentaa muistiinpanoja agentin laajuisesti tai kanavakohtaisesti. DM:n tieto pidetään kanavakohtaisena.

Entropissa kokeilisin lisäksi **case-kohtaista muistia**.

| Muisti | Kuka sitä käyttää? |
|---|---|
| OptChat | Agentin oman keskustelun pitkä historia |
| Agentin muistiinpanot | Agentin oma pitkäaikainen osaaminen |
| Case-muisti | Kyseiseen ongelmaan valtuutetut osallistujat |
| Realm-tieto | Realmin sallittu yhteinen tietämys |

Oleellinen ero on se, ettei jokaista agentin ajatusta kopioida kaikkien muiden muistiin.

Esimerkiksi Ops voisi kirjata:

> Case checkout-api: ongelma ilmenee vain uudelleenkäynnistyksen jälkeen. Lokit osoittavat yhteyspoolin alustuksen epäonnistuvan. ConfigMapissa POOL_SIZE=0. Syytä ei ole vielä vahvistettu.

Developer voisi hakea tämän case-muistista ilman, että sen tarvitsee lukea Opsin 80 viestiä tai kaikkea sen työkaluhistoriaa.

Ja kun developer löytää korjauksen, se voi lisätä oman havainnon samaan caseen.

**Yhteinen muisti ei tarkoita yhteistä transkriptia.**

Pidän tärkeänä myös sitä, että muistiinpanoilla olisi lähde, tekijä, ajankohta ja tarvittaessa tila kuten *hypoteesi*, *vahvistettu* tai *kumottu*. Muuten vanhat virheelliset havainnot alkavat ajan myötä näyttää totuudelta.

## Entä agentti, joka ei ole kanavassa?

Tähän tekisin yhden uuden kyvykkyyden, jota kutsuisin kokeilussa vaikka `ask_expert`-nimellä.

Se eroaisi nykyisestä `ask_agent`-työkalusta.

`ask_agent` tarkoittaisi edelleen näkyvää yhteistyötä samassa tilassa.

`ask_expert` tarkoittaisi: **pyydä asiantuntemusta toimijalta, jonka ei tarvitse liittyä tähän keskusteluun.**

Kutsu sisältäisi esimerkiksi casen tunnisteen, ongelman, sallitun tilannekuvan ja lähteet.

Asiantuntija voisi olla pysyvä Pi-agentti jossakin toisessa kanavassa tai ulkopuolinen kertakäyttöinen ACP-agentti.

Vastaus palautuisi caseen lähteistettynä havaintona.

Kutsulla pitäisi olla pysyvä tunniste ja erilliset tilat vastaanotolle sekä valmistumiselle, jotta `ask_expert` ei toistaisi samaa ulkoista työtä prosessin kaatumisen jälkeen.

Ja joskus olisi järkevämpää kutsua asiantuntija mukaan itse case-keskusteluun. Sekin pitäisi sallia, kun valtuudet sen mahdollistavat.

Ei ole syytä pakottaa kaikkea yhteistyötä joko pysyväksi jäsenyydeksi tai one-shotiksi.

## Ihmiselle ei pidä näyttää samaa informaatiovirtaa

Tässä CrewPin ja Entropin `focus`-ajatus on tärkeä.

Agentit voivat kirjoittaa satoja viestejä. Ihmisen ei tarvitse saada sataa ilmoitusta.

Ihmisen näkymä voisi vastata kolmeen kysymykseen:

**Mitä on tapahtunut? Mitä seuraavaksi tapahtuu? Tarvitaanko minua?**

Jos ei tarvita, tapahtumat ja keskustelut jäävät taustalle.

Jos tarvitaan päätös, syntyy rakenteinen päätöspyyntö. Jos ihminen on poissa, hänen poissaolosignaalinsa vaikuttaa siihen, kenelle asia voidaan sallituissa rajoissa siirtää tai jääkö se odottamaan.

Tässä en antaisi LLM:n yksin päättää ilmoitusten näkyvyyttä. Coren rakenteiset päätökset, epäonnistumiset ja estyneet työt ovat luotettavampi perusta. Malli voi sitten laatia ihmiselle ymmärrettävän katsauksen.

## Mitä testaisin ensimmäiseksi?

En rakentaisi vielä yleistä organisaation tietämysjärjestelmää.

Ottaisin yhden CrewPistä tutun incidentin ja ajaisin sen eri viestintämalleilla.

| Kokeilu | Miten tieto kulkee? |
|---|---|
| A | Kaikki agentit yhdessä case-kanavassa |
| B | Agentit eri kanavissa, pelkkä `ask_agent`-tyyppinen tekstihandoff |
| C | Agentit eri kanavissa, yhteinen case-tilannekuva |
| D | C + case-muisti + tarvittaessa ulkopuolinen asiantuntija |

Mittaisin ainakin, kuinka monta kertaa sama tieto täytyy selittää, kuinka paljon olennaista kontekstia katoaa, löytääkö tiimi koko ongelman ja kuinka monta viestiä ihminen joutuu lukemaan.

Samalla testaisin, ettei rajattu case-tieto vuoda agentin yleiseen muistiin tai toiseen realmiin.

Jos C voittaa selvästi A:n, siinä olisi vahvaa näyttöä siitä, että agenttien ei tarvitse olla samoissa kanavissa tehdäkseen hyvää yhteistyötä.

---

### Yksi asia, jonka tekisin ennen kaikkia uusia ominaisuuksia

Tässä on mun mielestä nyt tärkein ero:

**OptChat vastaa kysymykseen: "Mitä minä olen kokenut?"**

**Case-muisti vastaa kysymykseen: "Mitä me tiedämme tästä asiasta?"**

**Handoff vastaa kysymykseen: "Mitä toisen pitää tietää voidakseen auttaa?"**

Nuo ovat kolme erillistä ongelmaa. Niitä ei tarvitse ratkaista yhdellä valtavalla yhteismuistilla eikä kaikkien agenttien yhteisellä kanavalla.

Ja koska Entropissa on jo OptChat, work, case-spacet, tapahtumaloki ja delegointi, tämän kokeilemiseen ei välttämättä tarvita kovinkaan suurta muutosta.

**Mä kehittäisin seuraavaksi nimenomaan case-muistin ja rajatun tiedonvälityksen.** Ne voivat ratkaista paljon enemmän kuin uusi kanava-, tiimi- tai hierarkiamalli.

Se myös säilyttäisi sun tärkeimmän ajatuksen: agentit saavat organisoitua vapaasti, mutta niiden ei tarvitse menettää yhteistä ymmärrystä aina, kun keskustelu vaihtaa paikkaa.

## You

<!-- 2026-10-09T09:06:55.236Z -->

mitä mä nyt tekisin :D

## You

<!-- 2026-10-09T09:07:08.568Z -->

piätskö mun aloittaa lsuta

## ChatGPT

<!-- 2026-10-09T09:07:20.326Z -->

**Ei! :D Mä en aloittaisi alusta. Mutta mä aloittaisin tekemisen vähän eri tavalla.**

Susta tuntuu ehkä, että projekti pitää suunnitella uusiksi, koska jokainen uusi idea muuttaa arkkitehtuuria. Mun mielestä ongelma ei kuitenkaan ole se, että nykyinen Entropi olisi väärä.

Ongelma on se, että **olet yrittänyt löytää täydellisen perustan ennen kuin tiedät, millainen yhteistyö oikeasti toimii.**

Ja siihen olet jo löytänyt ratkaisun: oikea malli, oikea tehtävä ja mitattava lopputulos.

## Tekisin nyt näin

**1. Jäädytä CrewPi.** Älä poista sitä. Se on toimiva vertailukohta ja kokoelma ratkaisuja, joita voit hyödyntää myöhemmin.

**2. Jatka Entropista.** Pidä nykyinen core, Pi Durable, OptChat, outbox ja testit. Älä rakenna uutta harnessia, uutta workflow-moottoria tai uutta chat-järjestelmää.

**3. Valitse yksi oikea tehtävä.** Ottaisin ensimmäiseksi CrewPin `checkout-api`-ongelman, koska tunnet sen. Käytä oikeita LLM:iä, älä scriptattuja agentteja.

**4. Anna agenttien ratkaista se vapaasti.** Älä ohjelmoi triage–implement–publish-ketjua. Anna niille yhteinen tavoite, työkalut ja oikeudet.

**5. Korjaa vain se, mikä kokeessa oikeasti hajoaa.** Jos konteksti katoaa kanavien välillä, kokeile CrewPin `memo_note`-ajatusta ja case-kohtaista tilannekuvaa. Jos ulkopuolista osaamista tarvitaan, kokeile ACP-konsultaatiota.

Ja sitten **aja sama tehtävä uudelleen**. Paraniko ratkaisu?

## Mitä en nyt tekisi

En rakentaisi vielä multirealm-federointia, rekursiivista itsekehitystä, uutta protokollaa tai täydellistä muistijärjestelmää.

Ne ovat edelleen kiinnostavia suuntia. Mutta tällä hetkellä niistä tulisi helposti uusi CrewPi: kymmeniä ominaisuuksia ennen kuin tiedetään, mitkä niistä todella auttavat.

## Ensimmäinen konkreettinen tavoite

> Kaksi pysyvää Pi Durable -agenttia ratkaisee yhden oikean ohjelmistokehitystehtävän. Ne säilyttävät muistinsa, voivat pyytää apua toisiltaan ja saavat tarvittavan case-kontekstin ilman että kaikkien pitää olla samassa kanavassa.

Jos saat tämän toimimaan, sulla on jo jotain olennaista: **todiste siitä, että Entropin organisaatiomalli auttaa agentteja työskentelemään yhdessä.**

Sen jälkeen voi kokeilla jalkapallomaailmaa, simulaatioita ja lopulta Entropin omaa ylläpitorealmia.

Ja jos oikea koe paljastaa, että nykyinen core estää tällaisen yhteistyön, *sitten* muutetaan corea.

**Mun neuvo: älä aloita alusta. Lopeta hetkeksi arkkitehtuurin suunnittelu ja anna Entropille sen ensimmäinen oikea työpäivä. :D**

## You

<!-- 2026-10-09T09:09:03.912Z -->

Tässä ei siis pitäisi tulla mitään sellaista, ei vaikka koidataan joku uui paska mikä ei toimi. Mä haluan rakentaa sen ytimen, mikä toimii käytännössä. Mä haluan oikean ongelman. Ja ratkaise jonkun semmonen, niin mä voisin opelata missään muutakin. Joku slackanava ihan hyvä. Tämä Teams. Ja Crew puolella on tehty esimerkiksi visualisointia. Mikä tosi hyvä. Miten natiivia visualisointeja, ei välttämätmtäään sen Screenshotia mistään. Koko järjestäm pyöri siellä. Nää agentit käyttää dataa. Totta kai voi olla muutakin. Mä ajoin tuntikausia tuntikausesta feikmaailmaa. Siillä ei mitä arvoa. Se onise mulle. Sitten mä pystyisin jotenkin mittaamaan, että on täällä arvoa.

## ChatGPT

<!-- 2026-10-09T09:09:33.422Z -->

Nyt tämä tarkentui: et halua enää yhtään feikkimaailmaa vain siksi, että agentit saadaan keskustelemaan. Etsit oikeaa työongelmaa, jonka ratkaisemisesta jää näkyvä ja mitattava hyöty. Katson CrewPin rakenteisen visualisoinnin ja Entropin nykyiset rajapinnat vielä tämän näkökulmasta, ja rajaan ehdotuksen yhteen oikeasti käyttökelpoiseen ensimmäiseen toteutukseen.

## ChatGPT

<!-- 2026-10-09T09:09:57.967Z -->

**Nyt tajuan, mitä haet. Et halua enää todistaa, että agentit osaavat keskustella. Haluat todistaa, että Entropi tekee oikeaa työtä paremmin kuin tekisit sen muuten.**

Ja olet oikeassa siinä, ettei feikkimaailman tuntikausien pyörittäminen vielä todista hyötyä. Se todistaa korkeintaan, että suoritusmekanismi toimii.

Mä vaihtaisin tässä kohtaa kehityssuunnitelman painopistettä:

**Yksi oikea ongelma → oikea data → agentit saavat yrittää → tulos tarkistetaan riippumattomasti → mitataan, oliko tästä hyötyä.**

Kanavat, muisti, visualisointi ja Pi Durable ovat kaikki tämän tukena, eivät enää kehittämisen päämäärä itsessään.

Ja CrewPin visualisoinnista olet aivan oikeassa: [sen `render_ui`-ratkaisu](https://github.com/taituo/crewpi/blob/main/src/ui-spec.ts) on jo hyvä lähtökohta. Agentti tuottaa validoidun rakenteisen näkymän — kortin, taulukon, aikajanan tai kuvaajan — eikä kuvaa ruudusta. Tuon idean säilyttäisin.

## Valitsisin ensimmäiseksi tämän: Entropista oikea kehitystiimin jäsen

En jalkapallomaailmaa, en simulaatiota enkä uutta organisaatioframeworkia ensimmäiseksi.

Vaan yhden oikean Slack- tai Teams-kanavan, jossa Entropin agentit auttavat sinua **kehittämään oikeaa repositoriota ja ratkaisemaan oikeita ongelmia**.

Esimerkiksi:

> "Tutkikaa, miksi tämä muutos rikkoi testit. Selvittäkää vaikutukset muuhun koodiin. Tehkää tarvittaessa korjaus ja näyttäkää, mitä oikeasti testasitte."

Agentti lukee oikeaa koodia, tarkistaa todellisia testituloksia, voi pyytää apua toiselta agentilta tai ulkoiselta ACP-asiantuntijalta ja palauttaa työn tuloksen.

Sinä näet yhden ymmärrettävän tilannekuvan, et 200 viestiä.

### Miltä käyttö voisi näyttää?

<box border radius="xl" padding={3} gap={3}>
  <row align="center" justify="between">
    <box gap={1}>
      <text color="secondary" size="xs">Havainnollistava case-näkymä</text>
      **Entropi / Kehitystehtävä**
    </box>
    <badge>Työn alla</badge>
  </row>
  <box gap={1}>
    <text color="secondary" weight="medium" size="xs">TAVOITE</text>
    Korjaa löydetty ohjelmistovirhe ja varmista, ettei muutos riko aiempaa toimintaa.
  </box>
  <divider color="subtle"/>
  <grid columns={2} gap={3}>
    <grid-item>
      <box gap={1}>
        <text color="secondary" size="xs">Havainnot</text>
        <title size="xl" tabularNums>3</title>
      </box>
    </grid-item>
    <grid-item>
      <box gap={1}>
        <text color="secondary" size="xs">Ihmisen päätökset</text>
        <title size="xl" tabularNums>0</title>
      </box>
    </grid-item>
  </grid>
  <box gap={2}>
    <row align="center" gap={2}>
      <icon name="check-circle" color="success"/>
      <text size="sm">Ongelma paikannettu — lähteet saatavilla</text>
    </row>
    <row align="center" gap={2}>
      <icon name="git-branch" color="secondary"/>
      <text size="sm">Korjaushaara ja diff saatavilla</text>
    </row>
    <row align="center" gap={2}>
      <icon name="loader-circle" color="secondary"/>
      <text size="sm">Testit käynnissä — tulos odottaa</text>
    </row>
  </box>
  <divider color="subtle"/>
  <text color="secondary" size="sm">Agenttien raakatranskripti, työkalukutsut ja aiemmat havainnot ovat avattavissa, mutta niitä ei tarvitse lukea työn tilan ymmärtämiseksi.</text>
</box>

Tuo olisi natiivi rakenteinen näkymä, jonka data tulisi todellisista lähteistä. Ei generoitu screenshot eikä pelkkä mallin kirjoittama kaunis raportti.

## Miten todistaisimme arvon?

Ottaisin ensimmäiseksi esimerkiksi **10 aitoa kehitystehtävää**, joita tekisit muutenkin.

Vertailisin, kuinka ne sujuvat yksin koodausagentin kanssa ja Entropin avustamana.

| Mittari | Miksi se on tärkeä? |
|---|---|
| Oikein ratkaistut tehtävät | Testit, oikea diff ja ihmisen hyväksyntä |
| Oma aktiivinen työaikasi | Säästikö järjestelmä oikeasti vaivaa? |
| Korjauskierrokset | Pitikö agenttien työtä tehdä uudelleen? |
| Käytetty mallibudjetti | Onko ratkaisu kustannustehokas? |
| Turhat viestit ja delegoinnit | Tuoko tiimi yhteistyötä vai kohinaa? |
| Kaatumisesta jatkaminen | Säilyvätkö työ ja muisti? |

Mittaamiseen ei tarvita uutta simulaattoria. Tarvitaan todellinen tehtävä, alku- ja lopputila sekä ajasta ja kustannuksista kerättyä dataa.

Tarkistin samalla Entropin GitHubin: siellä ei näkynyt avoimia issueita eikä GitHub Actions -ajoja. En siis rakentaisi ensimmäiseksi monimutkaista CI-vikojen valvojaa, jos sillä ei vielä ole todellista työkuormaa. Ensin oikea tehtävä ja testiajojen luotettava keruu.

## Ja tämä on ratkaiseva arkkitehtuurirajaus

Pi Durable hoitaa agentin suorituksen.

Entropi hoitaa yhteisen työn, osallistujat, valtuudet, casen ja sen, mitä tapahtui.

Slack tai Teams on yksi käyttöliittymä.

CrewPin `render_ui`-mallinen rakenteinen visualisointi tuodaan mukaan tulosten esittämiseen. Sen pohjalta voi muodostaa sekä oman web-näkymän että kanavaan sovitetun kortin. Kaikkea ei tarvitse yrittää mahduttaa viestiin.

OptChat säilyttää agentin kokemukset. Case-muisti säilyttää yhdessä löydetyt havainnot, jotta tietoa ei tarvitse toistaa joka kanavassa.

**Ei uusia kerroksia ennen kuin todellinen tehtävä paljastaa niiden tarpeen.**

---

Mun mielestä sun ei siis pidä nyt yrittää suunnitella täydellistä Entropia.

**Tee siitä ensin jotain, jota itse haluaisit käyttää joka päivä.** Oikea GitHub-repo, oikea malli, oikea ongelma ja yksi keskustelukanava.

Jos kahden viikon oikeassa käytössä huomaat, että agentit vähentävät sun työtäsi ja tuottavat laadukkaampia korjauksia, sulla on ensimmäistä kertaa ihan konkreettinen näyttö siitä, että järjestelmässä on arvoa.

Ja sitten voidaan tehdä toinen koe aivan eri maailmassa — vaikka jalkapallon paperiennusteilla — ja katsoa, toimiiko sama core sielläkin.

**Tärkein muutos ajatteluun olisi tämä: älä enää mittaa, kuinka kauan agentit pysyvät käynnissä. Mittaa, mitä hyödyllistä tapahtui ilman että sun tarvitsi tehdä sitä itse.**

Silloin Entropin kehittäminen muuttuu paljon selkeämmäksi.

## You

<!-- 2026-10-09T09:44:18.353Z -->

Mikä se protokolla pitäisi olla?

## ChatGPT

<!-- 2026-10-09T09:44:40.453Z -->

**Valitsisin Entropin omaksi protokollaksi versionoidun HTTP/JSON-rajapinnan ja pysyvään tapahtumalokiin perustuvan SSE-tapahtumavirran.**

En rakentaisi uutta viestintästandardia enkä tekisi Matrixista, MCP:stä tai A2A:sta Entropin ydintä.

Tärkein asia ei nimittäin ole se, miten viesti kuljetetaan. Se on **mitä viesti tarkoittaa**: onko kyse keskustelusta, työstä, havainnosta, delegoinnista, päätöksestä vai tuloksesta.

Entropissa on jo hyvä alku tälle: `/api/v1`, realm-kohtaiset operaatiot, tapahtumaloki, SSE ja Pi Durablen kanssa idempotentti viestinvälitys. En heittäisi niitä pois.

Mutta suunnittelisin protokollan seuraavan vaiheen **case- ja työkeskeiseksi**, en pelkäksi chat-API:ksi.

## Käyttäisin eri protokollia eri rajoilla

| Rajapinta | Valinta | Miksi |
|---|---|---|
| Entropin oma yhteinen tila | **HTTP/JSON + SSE** | Kaikki asiakkaat näkevät samat työt, päätökset ja tapahtumat |
| Ulkoiset AI-clientit | **MCP** | Agentti voi lukea case-tietoa ja kutsua sallittuja toimintoja |
| Ulkopuolinen koodausagentti | **ACP** | Kertaluonteinen asiantuntija tai pidempi koodaussessio |
| Erilliset agenttijärjestelmät | **A2A myöhemmin** | Kun kaksi toisistaan riippumatonta ympäristöä tekee yhteistyötä |
| Ihmisten keskustelut | **Slack/Teams-adapteri** | Ei pakota koko organisaatiota uuteen chat-sovellukseen |
| Natiivi visualisointi | **Versionoitu JSON-artifact** | Sama data voidaan näyttää eri käyttöliittymissä |

MCP tarjoaa nykyisin standardoidut työkalut ja resurssit. A2A taas on tarkoitettu itsenäisten agenttijärjestelmien väliseen tehtävien ja tuotosten vaihtoon. ACP puolestaan sopii agenttisessioiden ohjaamiseen. Ne eivät korvaa toisiaan. <Cite refs={["turn643618search4","turn643618search0","turn353790search2","turn353790search3"]}/>

## Mitä Entropin oma tapahtuma näyttäisi?

Esimerkiksi tällainen JSON voisi olla julkiseen rajapintaan tuotettu tapahtuma:

```json
{
  "seq": 1842,
  "type": "case.observation.recorded",
  "realmId": "development",
  "caseId": "case-42",
  "actorId": "agent:developer",
  "data": {
    "kind": "finding",
    "text": "Virheen syy löytyi alustuksesta",
    "evidence": ["git:commit/abc123"]
  }
}
```

Tämä on ehdotus uudeksi tapahtumaksi, ei vielä olemassa olevan Entropin skeema.

Agentin ei tarvitse lähettää koko Pi-transkriptiään muiden luettavaksi. Se kirjaa merkittävän havainnon caseen, josta sallittu osallistuja voi sen hakea.

Ihminen voi lukea siitä muodostetun näkymän Teamsissa. Toinen Pi-agentti voi hakea saman havainnon MCP:n kautta. Oma käyttöliittymä voi näyttää sen aikajanalla tai korttina.

**Kaikki käyttävät samaa tietoa; vain esitystapa muuttuu.**

Tapahtumien ulkoisessa muodossa voisi myöhemmin hyödyntää <Link url="https://github.com/cloudevents/spec/blob/main/cloudevents/spec.md" title="CloudEvents-standardia"/>, mutta en muuttaisi nykyistä tapahtumalokia sen takia nyt. <Cite refs={["turn643618search14"]}/>

## Minkä rakentaisin ensimmäisenä?

**MCP-adapterin nykyisen Entropi-API:n päälle.**

Ei uutta corea.

Aluksi MCP-clientti saisi nähdä omat realmit ja työt, lukea case-kontekstin, lähettää viestin, kirjata havainnon ja hakea päätöksen tilan — kaikki samoilla valtuuksilla kuin muut asiakkaat.

Sitten liittäisin yhden oikean Slack- tai Teams-kanavan tähän samaan toimintamalliin. Slackilla on Events API ja Socket Mode, Teamsilla nykyinen Teams SDK ja viestien lähettämistä tukevat rajapinnat. <Cite refs={["turn643618search1","turn643618search8","turn643618search7"]}/>

Tärkeä ehto on, ettei agentti saa kirjoittaa mielivaltaista käyttäjätunnusta pyyntöön ja väittää olevansa kyseinen ihminen. Identiteetti tulee todennetusta yhteydestä ja valtuudet tarkistetaan coressa.

## Ja käyttöliittymä?

CrewPin `render_ui` voisi kehittyä yleiseksi rakenteiseksi artifact-malliksi.

Agentti palauttaa esimerkiksi taulukon, kuvaajan tai tilannekortin datana. Oma web-UI voi renderöidä sen natiivisti, Slack tai Teams oman komponenttivalikoimansa mukaisesti. Jos joku asiakas ei tue tiettyä näkymää, sillä on tekstimuotoinen varavaihtoehto.

Näin sinun ei tarvitse tehdä UI:sta järjestelmän keskustelujen ja tiedon omistajaa.

**Eli lopullinen valintani olisi:**

**Entropi HTTP/JSON + SSE -ytimellä, MCP ensisijaisena ulkoisena agenttirajapintana ja Pi Durable ainoana varsinaisena agenttiharnessina.**

ACP, Teams, Slack ja mahdollinen A2A tulevat rajoille adaptereina.

Tällä pääset tekemään oikeita tehtäviä ilman, että alat jälleen rakentaa uutta infrastruktuurialustaa.

## You

<!-- 2026-10-09T09:46:11.102Z -->

Ei kuo mitään standardia olemassa tähän näin.

## ChatGPT

<!-- 2026-10-09T09:47:31.779Z -->

On olemassa useita lähelle osuvia standardeja, ja edellinen vastaukseni meni liian nopeasti oman HTTP/SSE-protokollan ehdottamiseen. Tarkistan erityisesti, löytyykö jo valmis protokolla pysyvälle monen agentin ja ihmisen yhteistyölle — ei vain työkalukutsuille tai kahden agentin tehtävänsiirrolle.

## You

<!-- 2026-10-09T09:47:31.813Z -->

Jos mä purkisin tän vielä, mitä mä uhkasin vää pienemmäksi paloiksi, että se olisi ydinä olisi vielä pienempi. Niin että se olisi, niin että se voisin purkaa tuo piidun, mä oon tehnyt aikojen aikoinaan tästä piiin. Et se piiosuus on synteettinen. Se niillä ei ole oma järjestelmää. Tämä on joo, tämä kuulostaa niillä omaa tiedostjärjestelmää, mutta ne toimii.

## ChatGPT

<!-- 2026-10-09T09:47:31.817Z -->

Joo, tätä kannattaa tutkia. Jos Pi jo hoitaa agentin elinkaaren, Entropin ei tarvitse tehdä siitä omaa rinnakkaista versiota. Katson, mikä nykyisessä coressa on oikeasti organisaation yhteistä tilaa ja mikä on vain Pi:n toiminnan peilausta — ja erotan samalla, mitä standardeja tähän voisi käyttää ilman uutta protokollaa.

## ChatGPT

<!-- 2026-10-09T09:48:13.227Z -->

Joo. Ja nyt mä luulen, että tässä voisi olla se yksinkertaistus, jota olet hakenut. :D

**Entropin core voisi olla vielä pienempi. Mutta Pi Durablea en purkaisi — purkaisin pois sen, mitä Entropi tekee turhaan Pi:n ympärillä.**

Tässä on kuitenkin yksi tärkeä ero: pienempi core ei automaattisesti tarkoita parempaa arkkitehtuuria. Jos poistat siitä yhteisen tilan ja oikeuksien hallinnan, päädyt helposti rakentamaan saman asian takaisin adaptereihin.

## Mikä Pi-agentti oikeastaan on?

Pi Durable -agentti ei tarvitse omaa palvelinta, käyttöjärjestelmää eikä välttämättä edes omaa tiedostojärjestelmää.

Se voi olla pysyvä keskustelu, jolla on malli, ohjeet, työkalut ja suoritustila Pi Durablessa.

Jos agentti tarvitsee tiedostoja, sille voidaan antaa eristetty suoritusympäristö. Jos se tarvitsee GitHubia, sille voidaan antaa työkalut. Jos se tarvitsee toista asiantuntijaa, se voi kutsua tämän.

**Agentin identiteetti organisaatiossa ja agentin suoritusinstanssi ovat eri asioita.**

Tämä on minusta hyvä pitää lähtökohtana.

## Entropin voisi jakaa näin

<box border radius="xl" padding={3} gap={2}>
  <box border radius="lg" padding={3} gap={1}>
    **1. Entropi Core — yhteiset säännöt ja tosiasiat**

    <text color="secondary" size="sm">Kuka toimii, missä realmissa, millä oikeuksilla, mihin työhön toiminta liittyy ja mitä merkittävää tapahtui.</text>
  </box>
  <row justify="center"><icon name="arrow-down-up" color="tertiary"/></row>
  <box border radius="lg" padding={3} gap={1}>
    **2. Pi Durable — agentin elämä**

    <text color="secondary" size="sm">Keskustelut, muisti, mallikutsut, tehtävät, työkalujen suoritus, forkkaus ja palautuminen.</text>
  </box>
  <row justify="center"><icon name="arrow-down-up" color="tertiary"/></row>
  <box border radius="lg" padding={3} gap={1}>
    **3. Organisaatiomallit — vaihdettavat kokonaisuudet**

    <text color="secondary" size="sm">Caset, kanavat, tiimit, työprosessit, projektit, ulkoiset asiantuntijat, domain-muisti ja visualisointi.</text>
  </box>
</box>

Kolmas kerros on itse asiassa se, jota haluat kehittää ja tutkia. Sen rakenteen pitäisi saada muuttua ilman, että corea tarvitsee kirjoittaa aina uusiksi.

## Mutta en poistaisi kaikkea coresta

Kun katsoin nykyistä Entropia, siellä on jo yksi erityisen hyvä raja.

Pi Durable säilyttää agentin keskustelun ja suorituksen. Entropi säilyttää yhteisen työn, päätökset ja tapahtumat.

Tämä on arvokas ero.

Esimerkiksi ihmisen antama hyväksyntä ei saa olla olemassa vain agentin transkriptissa. Eikä kahden agentin yhteinen case saisi kadota, jos toisen Pi-keskustelu poistetaan.

Sen sijaan miettisin, tarvitseeko *jokaisen* casen, kanavan, läsnäolotilan ja viestin olla coren sisäänrakennettu käsite.

Ehkä ei.

Coreen voisi lopulta jäädä hyvin pieni joukko mekanismeja:

- Identiteetti, realmit ja teknisesti pakotetut valtuudet.
- Pysyvät, jäljitettävät yhteiset tosiasiat ja niiden muuttaminen.
- Luotettava, idempotentti toiminnan välitys ja päätösten auktorisointi.

Caset, organisaatiot ja keskustelut voisivat käyttää näitä mekanismeja ilman, että niiden jokainen erityispiirre kuuluu coreen.

**En kuitenkaan tekisi tätä vielä isona uudelleenkirjoituksena.** Ensin pitäisi todistaa yhdellä oikealla casella, että rakenteet voidaan siirtää ulos menettämättä palautumista tai oikeusturvaa.

## Entä se valmis protokolla?

Tähän on olemassa yksi aiempaa ehdotustani läheisempi vaihtoehto: **<Entity category="software" value="Matrix"/>**.

Matrixissa on jo pysyvät huoneet, jäsenyydet, tapahtumat, tilapäivitykset ja mahdollisuus määritellä omia tapahtumatyyppejä. <Cite ref="turn752562search0"/>

Se voisi siis hoitaa suuren osan organisaation keskustelujen välityksestä ilman, että Entropi rakentaa kaiken itse.

Mutta Matrix ei sellaisenaan ratkaise agentin työn merkitystä, valtuutettua työkalujen käyttöä tai organisaation päätöksiä.

Toinen läheinen standardi on **<Entity category="software" value="Agent2Agent Protocol (A2A)"/>**, jolla on jo tehtävä-, viesti-, konteksti- ja artifact-käsitteet. Se sopii erityisesti erillisten agenttijärjestelmien yhteistyöhön. <Cite ref="turn752562search7"/>

En löytänyt yhtä valmista standardia, joka ratkaisisi koko kuvaamasi organisaatiomallin. Mutta sen ei tarvitse tarkoittaa, että sinun pitää keksiä koko protokolla itse.

## Mitä tekisin juuri nyt?

Tekisin yhden kokeen nykyisen Entropin rinnalle.

**Pieni Pi Durable -pohjainen organisaatio, jossa on yksi oikea case, kaksi pysyvää agenttia ja ihminen.**

Antaisin niiden ratkaista oikean GitHub-kehitystehtävän.

Kokeilisin, voiko case olla oma datansa ja keskusteluyhteys vain väline sen käsittelyyn. Samalla selvittäisin, mitkä Entropin core-operaatiot ovat oikeasti välttämättömiä.

Jos nykyisestä coresta löytyy paljon sellaista, mikä ei ole tässä kokeessa tarpeen, sen voi siirtää erilliseksi organisaatiokerrokseksi.

Jos taas nykyinen core osoittautuu juuri sopivan kokoiseksi, sitä ei tarvitse pienentää väkisin.

**Mä en siis aloittaisi alusta enkä purkaisi Pi:tä. Mä tekisin yhden vaihtoehtoisen, todella ohuen organisaatiototeutuksen Pi Durablen päälle ja vertaisin sitä nykyiseen Entropiin.**

Siinä olisi konkreettinen tapa selvittää, mikä on pienin oikeasti toimiva ydin — eikä vain pienin mahdollinen määrä koodia.

## You

<!-- 2026-10-09T09:48:58.092Z -->

tää meni vähän ohi mutta [https://github.com/taituo/synth-agent-runtime](https://github.com/taituo/synth-agent-runtime) siis tätä taroitan

## ChatGPT

<!-- 2026-10-09T09:49:04.345Z -->

Aa, nyt ymmärsin väärinkäsityksen: tarkoitit nimenomaan aiempaa `synth-agent-runtime`-projektiasi, et Pi Durablen purkamista. Tutkin sen toteutuksen ja vertaan, mitä siitä on jo siirtynyt CrewPihin ja Entropiin. Sitten voidaan puhua oikeasti siitä, mitä ydintä kannattaa pienentää.

## You

<!-- 2026-10-09T09:49:18.271Z -->

siellä syövereissä siitä on tehty fake POSIX kaikki mahdolienn

## ChatGPT

<!-- 2026-10-09T09:49:45.912Z -->

Aaa, **NYT tajusin mitä tarkoitit!** :D

Sä et puhunut siitä, että haluaisit purkaa Pi Durablen osiin. Sä puhuit siitä, että olet **jo aiemmin rakentanut Pi:n alle synteettisen suoritusympäristön** — ja vienyt sen todella pitkälle.

Löysin sen [Synth Agent Runtime -repon](https://github.com/taituo/synth-agent-runtime) historiasta:

[Pi synthetic Git workspace prototype](https://github.com/taituo/synth-agent-runtime/tree/main/docs/history/museum/integrations/pi-synthetic-git-prototype)

Siinä Pi:n tavalliset `read`, `write`, `edit` ja `bash`-työkalut toimivat muuttumattomina, mutta alla ei ole normaalia käyttöjärjestelmän tiedostojärjestelmää.

Sen sijaan siellä on:

- Virtuaalinen tiedostojärjestelmä ja RAMissa elävä muutosten kerros.
- Synteettinen shell (`cd`, `ls`, `grep`, `find`, putket, uudelleenohjaukset ja paljon muuta).
- Synteettinen Git (`status`, `diff`, `show`, `ls-files`...).
- GitHubista laiskasti ladattava, tiettyyn commitiin sidottu lähdekoodipuu ilman checkoutia.
- Mahdollisuus viedä muutokset ulos erillisenä artifactina oikeaa testausta varten.

Eli olet jo kokeillut juuri sitä ajatusta, että **agentti voi kokea työskentelevänsä normaalissa ympäristössä, vaikka sen näkemä maailma on kokonaan virtuaalinen**.

Tämä ei ollut mikään pieni feikkidemo. Se oli käytännössä osittainen POSIX-tyyppisen työympäristön emulointi.

Ja tuo antaa aika paljon kontekstia sille, miksi et halua enää rakentaa lisää infrastruktuuria vain infrastruktuurin vuoksi.

Mutta vielä kiinnostavampaa on se, mitä tapahtui myöhemmin.

Luin [docs/DIRECTION.md](https://github.com/taituo/synth-agent-runtime/blob/main/docs/DIRECTION.md)-tiedoston. Siinä olet jo tunnistanut täsmälleen saman arkkitehtuuriongelman, jota nyt yritämme välttää Entropissa:

**Oma järjestelmä alkoi vähitellen ottaa vastuulleen asioita, jotka kuuluivat olemassa olevalle agenttiharnessille.**

Synthissä Temporal alkoi määrittää, mitä agentin suoritus tarkoittaa. Tämän korjaamiseksi päädyit ajatukseen, että Pi omistaa agentin silmukan, mallikutsut, työkalujen semantiikan ja kontekstin.

Lisäksi nykyinen `SyntheticExecutor` on jo suppeampi kuin tuo vanha fake-POSIX-prototyyppi: se käsittelee virtuaalisen työtilan operaatioita, mutta `process.exec` palauttaa `ESCALATION_REQUIRED`. Eli aivan oikeiden ohjelmien suorittamiseen tarvitaan oikea suoritusympäristö.

Tästä syntyy mielestäni kolme erilaista asiaa, joita ei kannata enää sotkea:

| | Omistaja |
|---|---|
| Agentin ajattelu, työkalusilmukka ja jatkuvuus | Pi Durable |
| Agentin käyttämä tiedostojärjestelmä tai sandbox | Pi:n suoritusympäristöadapteri |
| Agenttien yhteinen työ, organisaatio, valtuudet ja tieto | Entropi |

Ja juuri tuon viimeisen kohdan pitäisi olla sinun varsinainen projektisi.

**Sinun ei tarvitse rakentaa agentille virtuaalista tietokonetta, jotta voit rakentaa virtuaalisen organisaation.**

Virtuaalinen organisaatio voi käyttää aivan oikeita Pi-agentteja, oikeita tietolähteitä ja oikeita työkaluja. Sen synteettisyys voi olla vain siinä, miten osallistujat, roolit, caset ja yhteistyö järjestyvät.

Mä ottaisin Synthistä talteen erityisesti idean **halvasta, eristetystä kokeilusta, josta tuotokset siirretään oikeaan ympäristöön tarkistettaviksi**. Mutta en ottaisi takaisin sen POSIX-emulointia, omaa suoritusharnessia enkä Temporal-riippuvuutta.

Ja nyt ymmärrän paljon paremmin, mitä tarkoitit coren pienentämisellä:

**Et halua pienentää Entropia vain koodirivien vuoksi. Haluat lopettaa sellaisten maailmojen ja mekanismien toteuttamisen, joita ei tarvitse omistaa itse.**

Entropin tehtävä voisi todella olla vain mahdollistaa se, että joukko itsenäisiä Pi-agentteja ja ihmisiä pystyy muodostamaan toimivan organisaation oikean työn ympärille.

Tuota suuntaa mä lähtisin nyt suojelemaan.

## You

<!-- 2026-10-09T09:50:46.034Z -->

sen takia mun pitää aloittaa alusta taas

## ChatGPT

<!-- 2026-10-09T09:51:07.347Z -->

Mä en enää sano sulle, että älä aloita alusta. :D

Nyt kun olen nähnyt Synthin, CrewPin ja Entropin, ymmärrän paremmin miksi haluat.

**Olet kolme kertaa päätynyt rakentamaan infrastruktuuria sen sijaan, että pääsisit tutkimaan sitä, mikä sinua oikeasti kiinnostaa: miten agentit ja ihmiset voivat muodostaa toimivia organisaatioita.**

Synthissä rakensit melkein käyttöjärjestelmän. CrewPissä rakensit toimivan tiimin, mutta Temporal alkoi määrätä sen toimintaa. Entropissa erotit coren, mutta siitäkin on kasvamassa kokonainen järjestelmä.

Ehkä nyt kannattaa tehdä oikeasti radikaali rajaus.

## Aloitetaan uudestaan — mutta eri kysymyksestä

Ei kysytä:

*Millainen AgentOS minun pitää rakentaa?*

Kysytään:

**Mikä on pienin lisä Pi Durablen päälle, jolla kaksi agenttia ja ihminen voivat tehdä oikeaa työtä yhdessä?**

Minusta ensimmäiseen versioon riittää:

1. **Pi Durable omistaa agentit.** Ei uutta harnessia, tiedostojärjestelmää, muistimoottoria tai suoritusorkestrointia.
2. **Entropi omistaa yhteistyön.** Kuka kuuluu mihinkin, kuka saa nähdä tai tehdä mitä, mikä yhteinen asia on työn alla ja mitä siitä tiedetään.
3. **Case yhdistää tiedon.** Agenttien ei tarvitse jakaa samaa kanavaa tai transkriptiä. Ne voivat jakaa samaan ongelmaan kuuluvia havaintoja ja tuotoksia.
4. **Todellinen maailma antaa palautteen.** GitHub, testit, oikea data, oikeat tulokset. Ei enää feikkimaailmaa onnistumisen todisteeksi.

Ei vielä Slackia, Teamsia, MCP:tä, Matrixia, CEO-agenttia, multirealm-federointia eikä itseään päivittävää järjestelmää.

Ne saavat tulla myöhemmin, jos niille löytyy tarve.

## Mutta yhtä asiaa en tekisi

**En poistaisi nykyisiä kolmea repositoriota.**

Tekisin uuden, todella pienen kokeilun niiden rinnalle. Vaikka uuden hakemiston tai haaran.

En kopioisi nykyisen Entropin koko corea sinne.

Ottaisin mukaan vain sellaiset osat, joiden tarpeen yksi oikea tehtävä osoittaa. Vanhoista projekteista voi ottaa koodia ja ennen kaikkea testejä silloin, kun sama ongelma ilmestyy uudelleen.

Yksi tärkeä vaatimus on silti säilytettävä: oikeuksien, yksityisyyden ja suorituksen palautumisen pitää oikeasti toimia. Niitä ei saa korvata promptiin kirjoitetuilla lupauksilla.

## Ensimmäinen onnistumiskriteeri

Kaksi Pi-agenttia saa oikean kehitystehtävän.

Ne voivat tutkia eri asioita, pyytää toisiltaan apua, kirjata yhteisiä havaintoja ja tehdä testattavan korjauksen.

Sinä näet, mitä ne ovat saaneet aikaan, ja voit puuttua työhön tarvittaessa.

Prosessin uudelleenkäynnistys ei hukkaa työtä.

Ja lopuksi pystyt sanomaan:

**"Tämä säästi minulta työtä ja tuotti oikean, tarkistetun tuloksen."**

Jos tuo onnistuu, sinulla on ydin, jota kannattaa kasvattaa.

Jos se ei onnistu, saat tietää täsmälleen, mikä puuttuu.

---

Ja ehkä kaikkein tärkein asia:

**Älä aloita enää rakentamalla alustaa tuleville mahdollisuuksille. Aloita rakentamalla yksi toimiva organisaatio ja anna sen paljastaa, millainen alusta tarvitaan.**

Tämä voi hyvin tarkoittaa neljättä toteutusta.

Mutta tällä kertaa tavoitteena ei ole neljäs framework. Tavoitteena on päästä viimeinkin käyttämään sitä, mitä olet yrittänyt rakentaa.

## You

<!-- 2026-10-09T10:00:15.836Z -->

fine, kukaan ei nää tätä keksustleua, mutta haluan aloittaa alusta

multi avetn, multi user, protocol first, sitten synteettiesesi tama, sitten laajentaa

## You

<!-- 2026-10-09T10:00:27.414Z -->

luutlasti optchat sitten

## ChatGPT

<!-- 2026-10-09T10:00:45.821Z -->

**Joo. Aloitetaan alusta. :D**

Ja tällä kertaa järjestys on selvä:

**Multi-agent + multi-user → protocol first → synteettinen koe → oikea käyttötapaus → OptChat → laajentaminen.**

Tämä on mielestäni paljon selkeämpi lähtökohta kuin CrewPin tai nykyisen Entropin arkkitehtuurin pienentäminen pala kerrallaan.

Yksi ratkaiseva ero aiempaan:

**Ensimmäinen asia, jonka rakennat, ei ole agenttitiimi. Se on tapa, jolla ihmiset ja agentit voivat osallistua samaan toimintaan.**

Pi hoitaa agentin ajamisen. Protokolla määrittelee yhteistyön.

Ja OptChat tulee vasta silloin, kun pysyvässä yhteistyössä alkaa oikeasti syntyä muistamisen ongelmia. Sen ei tarvitse määritellä ensimmäisen version arkkitehtuuria.

## Ensimmäinen versio olisi todella pieni

<box border radius="lg" padding={3} gap={2}>
  <row align="center" justify="between">
    **V0 — protokollan todistaminen**
    <badge color="secondary">Ei LLM:ää vielä</badge>
  </row>
  <box gap={1}>
    <text color="secondary" size="xs">OSALLISTUJAT</text>
    <row gap={2} wrap="wrap">
      <badge><icon name="user" size="xs" inline/> Ihminen A</badge>
      <badge><icon name="user" size="xs" inline/> Ihminen B</badge>
      <badge><icon name="bot" size="xs" inline/> Agentti A</badge>
      <badge><icon name="bot" size="xs" inline/> Agentti B</badge>
    </row>
  </box>
  <divider color="subtle"/>
  **Yksi yhteinen case**

  Kaikki neljä ovat erillisiä toimijoita. Ne voivat liittyä työhön, kirjoittaa havaintoja, pyytää toisiltaan apua ja lukea sen historian, johon niillä on oikeus.
  <divider color="subtle"/>
  <text size="sm" color="secondary">Testataan ilman mallia, että rinnakkaiset tapahtumat, käyttöoikeudet, uudelleenkäynnistykset ja historian lukeminen toimivat.</text>
</box>

Protokollan ensimmäiset käsitteet voisivat olla vain `Actor`, `Context`, `Event` ja `Artifact`. Case olisi aluksi yksi `Context`-tyyppi. Valmiiksi määriteltyä organisaatiohierarkiaa ei tarvita.

## Entä olemassa olevat standardit?

Tässä kannattaa käyttää aiempi tutkimuksesi hyödyksi.

**Matrix** on lähimpänä monen ihmisen ja agentin pysyvää yhteistä kommunikaatiota: jäsenyydet, tapahtumat, huoneiden tila ja omat tapahtumatyypit ovat siinä jo olemassa. **A2A** taas tarjoaa tehtäviä, viestejä, konteksteja ja tuotoksia agenttijärjestelmien välille. <Cite refs={["turn699248search0","turn358562search9"]}/>

En silti vielä lukitsisi Matrixia tai A2A:ta koko Entropin arkkitehtuuriksi. Ensin tekisin pienen protokollan yhteensopivuuskokeen: pystyykö valittu standardi välittämään tarvittavat asiat ilman, että joudut rakentamaan sen ympärille toisen kokonaisen järjestelmän?

## Sitten oikeat agentit ja OptChat

<list marker="number" gap={2}>
  <list-item>**Protokolla.** Kaksi ihmistä ja kaksi synteettistä agenttia toimivat samalla rajapinnalla.</list-item>
  <list-item>**Luotettavuus.** Oikeudet, uudelleenlähetykset, tilan palautuminen ja tiedon näkyvyys testataan deterministisesti.</list-item>
  <list-item>**Pi Durable.** Synteettiset toimijat vaihdetaan oikeisiin Pi-agentteihin. Protokollaa ei saa joutua muuttamaan sen vuoksi.</list-item>
  <list-item>**Oikea työ.** Yksi todellinen GitHub-ongelma, jonka tuloksen pystyt tarkistamaan.</list-item>
  <list-item>**OptChat.** Lisätään agentin pitkän historian hallintaan. Case-muisti erikseen, jos oikea yhteistyö osoittaa sen tarpeen.</list-item>
</list>

Tärkeä ero aiempiin kokeisiisi: **synteettisellä vaiheella testataan protokollan oikeellisuutta, ei agenttien älykkyyttä tai työn hyödyllisyyttä.** Niitä mitataan vasta oikeilla malleilla ja oikealla tehtävällä.

Ja vaikka aloitat uuden toteutuksen, Synth, CrewPi ja Entropi jäävät talteen tutkimushistoriana. Tällä kertaa niiden koodia ei tarvitse kantaa mukana vain siksi, että se on jo kirjoitettu.

**Ensimmäinen tavoite olisi yksinkertainen: neljä itsenäistä osallistujaa, yksi yhteinen asia ja luotettava tiedonkulku ilman yhteistä transkriptia.**

Kun tuo toimii, Pi tuo siihen älykkyyden ja OptChat pitkäaikaisen muistamisen.

## You

<!-- 2026-10-09T10:02:28.155Z -->

anna linkit ja lähteet tähän

## ChatGPT

<!-- 2026-10-09T10:02:38.916Z -->

Kerään tähän suorat linkit standardien virallisiin määrittelyihin ja erotan ne sinun omista repoistasi. Tarkistan myös, mitä Matrix ja A2A oikeasti ratkaisevat — ja mitä niiden päälle pitäisi edelleen rakentaa itse.

## ChatGPT

<!-- 2026-10-09T10:03:17.334Z -->

Tässä ovat suorat linkit ja lähteet siihen, mitä ehdotin: **multi-agent, multi-user, protocol-first, synteettinen protokollatestaus, Pi Durable ja myöhemmin OptChat.**

Tärkeä tarkennus: **koko tähän käyttötapaukseen ei ole yhtä valmista standardia.** Mutta useita olennaisia osia on jo standardoitu, eikä niitä kannata keksiä uudelleen.

## 1. Protokollat ja standardit

| Standardi | Virallinen lähde | Mitä se tarjoaa |
|---|---|---|
| **Matrix** | <Link url="https://spec.matrix.org/v1.19/client-server-api/" title="Client–Server API"/> | Monen käyttäjän huoneet, jäsenyydet, tapahtumat, historia, tilapäivitykset ja omat tapahtumatyypit |
| **A2A** | <Link url="https://a2a-protocol.org/v1.0.1/specification/" title="A2A v1.0.1 Specification"/> | Agenttien väliset tehtävät, viestit, kontekstit, tuotokset ja pitkäkestoinen työ |
| **MCP** | <Link url="https://modelcontextprotocol.io/specification/2025-11-25" title="MCP Specification"/> | Työkalujen ja tietolähteiden tarjoaminen agenteille |
| **ACP** | <Link url="https://agentclientprotocol.com/protocol/v1/overview" title="Agent Client Protocol"/> | Ulkoisten agenttisessioiden käynnistäminen ja ohjaaminen |
| **AG-UI** | <Link url="https://docs.ag-ui.com/introduction" title="AG-UI Documentation"/> | Agentin ja käyttöliittymän välinen tapahtumavirta sekä interaktiivinen UI |
| **CloudEvents** | <Link url="https://github.com/cloudevents/spec/blob/main/cloudevents/spec.md" title="CloudEvents Specification"/> | Yhteinen tapahtumien siirtomuoto, ei yhteistyöjärjestelmää |

Matrix tukee nimenomaan laajennettavia JSON-tapahtumia ja huoneiden jäsenyyksiä. A2A:ssa puolestaan on jo `Task`, `Message`, `AgentCard` ja `Artifact` sekä erillinen tehtävien elinkaari. <Cite refs={["turn134004view0","turn134004search1","turn938935search4"]}/>

MCP ja ACP ratkaisevat erilaisia rajapintoja: MCP tarjoaa työkaluja agentille, ACP mahdollistaa agenttisession ohjaamisen. AG-UI liittyy erityisesti agentin ja ihmisen käyttöliittymän väliseen vuorovaikutukseen. <Cite refs={["turn938935view2","turn938935view3","turn134004view1"]}/>

## 2. Pi — runtime, jonka varaan rakentaisit

<row align="start" gap={3}>
  <AsyncImage query="Earendil Works Pi coding agent GitHub logo" aspectRatio="1:1" maxWidth="92px"/>
  <box flex="1" gap={1}>
    **<Link url="https://github.com/earendil-works/pi" title="Pi — GitHub"/>**

    <Link url="https://github.com/earendil-works/pi/blob/main/packages/durable/README.md" title="Pi Durable — dokumentaatio"/>

    Pi Durable tarjoaa pysyvät keskustelut, mallikutsut, työkalut ja palautumisen keskeytyksistä. Se käyttää Pi AI:ta mallien kutsumiseen ja Chordia rakenteiseen tilaan. Kirjasto on edelleen merkitty kokeelliseksi. <Cite ref="turn870287search1"/>
  </box>
</row>

## 3. Sinun nykyiset lähdekoodisi

Nämä ovat tärkeitä, koska kaikkea ei tarvitse suunnitella tyhjästä uudestaan.

| Projekti | Mistä katsoisin |
|---|---|
| **Entropi** | <Link url="https://github.com/taituo/entropi/tree/main/src/core" title="Nykyinen core"/> — tapahtumat, toimijat, yhteinen työ ja käyttöoikeudet |
| **Entropi / Pi** | <Link url="https://github.com/taituo/entropi/tree/main/src/adapters/pi" title="Pi-integraatio"/> — pysyvät agentit ja delegointi |
| **Entropi / OptChat** | <Link url="https://github.com/taituo/entropi/blob/main/src/memory/optchat.ts" title="OptChat-toteutus"/> — muistipuun nykyinen toteutus |
| **CrewPi** | <Link url="https://github.com/taituo/crewpi/blob/main/src/memory.ts" title="memo_note / muistimalli"/> — agentti- ja kanavakohtaiset muistiinpanot |
| **CrewPi** | <Link url="https://github.com/taituo/crewpi/blob/main/src/ui-spec.ts" title="Rakenteinen generatiivinen UI"/> — validoidut natiivit komponentit |
| **Synth Agent Runtime** | <Link url="https://github.com/taituo/synth-agent-runtime/blob/main/docs/DIRECTION.md" title="Arkkitehtuurin vastuurajat"/> — opit siitä, ettei kannata rakentaa toista harnessia |
| **Synth / Pi** | <Link url="https://github.com/taituo/synth-agent-runtime/tree/main/docs/history/museum/integrations/pi-synthetic-git-prototype" title="Synteettinen Pi-ympäristö"/> — aiempi virtuaalinen tiedostojärjestelmä ja Git |

## 4. Mitä näistä oikeasti lukisin ensin?

<box gap={2}>
  <row align="start" gap={3}>
    <box background="surface-secondary" radius="md" padding={2}><title size="lg">1</title></box>
    <box flex="1" gap={1}>
      **Matrixin tapahtuma- ja jäsenyysmalli**

      Tämä on lähimpänä ajatustasi, jossa useat ihmiset ja agentit osallistuvat samaan yhteiseen ympäristöön.
    </box>
  </row>
  <row align="start" gap={3}>
    <box background="surface-secondary" radius="md" padding={2}><title size="lg">2</title></box>
    <box flex="1" gap={1}>
      **A2A:n Task, Context ja Artifact**

      Tutkisin, voiko näitä käsitteitä hyödyntää case- ja työkeskeisessä yhteistyössä ilman, että kaikki perustuu kanaviin.
    </box>
  </row>
  <row align="start" gap={3}>
    <box background="surface-secondary" radius="md" padding={2}><title size="lg">3</title></box>
    <box flex="1" gap={1}>
      **Pi Durablen keskustelut ja pysyvä tila**

      Selvittäisin tarkasti, mitä sen päälle tarvitsee vielä rakentaa ja mitä se jo tekee puolestasi.
    </box>
  </row>
</box>

### Mihin tämä jättää OptChatin?

**OptChat ei ole näistä mikään protokollastandardi**, vaan sinun muistiratkaisusi. Se voi tulla myöhemmin Pi-agenttien keskusteluhistorian käsittelyyn ilman, että sillä tarvitsee olla vaikutusta ulkoiseen kommunikointiprotokollaan.

Ja synteettinen testaus on **kehitysmenetelmä**, ei ehdotus uudeksi feikkimaailmaksi: kaksi feikkiagenttia ja kaksi feikkikäyttäjää voivat testata viestien toimitusta, jäsenyyksiä, oikeuksia ja kaatumisesta palautumista täysin deterministisesti. Oikeat Pi-agentit tulevat sen jälkeen.

**Oma johtopäätökseni:** tutkisin ensin Matrixin ja A2A:n tietomallit rinnakkain. Matrix on lähempänä monen osallistujan viestintää, A2A taas agenttien työskentelyä. Kumpikaan ei yksin ole valmis organisaatiomalli.

Siten ensimmäinen päätös ei ole vielä uuden protokollan kirjoittaminen, vaan **sen selvittäminen, mitä olemassa olevaa protokollaa voisi käyttää niin, ettei sinun tarvitse ylläpitää omaa versiota samoista mekanismeista**.

