# BLE Diagnostic Scanner

**Diagnóstico e inventário Bluetooth Low Energy** para dispositivos autorizados.
Aplicativo web responsivo / PWA para técnicos que precisam identificar, conectar,
diagnosticar e registrar dispositivos BLE.

> ⚠ **Uso autorizado apenas.** Este aplicativo é uma ferramenta de diagnóstico.
> Ele **não** executa saques, liberação de notas, abertura de compartimentos,
> comandos de movimentação de dinheiro ou qualquer comando operacional de caixa
> eletrônico. ATM é tratado apenas como um possível equipamento cadastrado
> manualmente pelo técnico. Nenhum comando específico de ATM existe no código.

## Funcionalidades

- Scanner BLE com o seletor nativo do navegador (Web Bluetooth API).
- Detalhes do dispositivo (nome, ID, RSSI/Tx Power/anúncios quando o navegador fornecer).
- Conexão GATT, descoberta de serviços e características.
- Exibição de UUIDs (sem alteração) e propriedades reais (READ, WRITE, WRITE WITHOUT RESPONSE, NOTIFY, INDICATE).
- Leitura de características (apenas quando permitido) com visualização HEX / UTF-8 / contagem de bytes.
- Monitor de notificações em tempo real com pausa, limpeza e exportação.
- Ferramenta de escrita **genérica** (desabilitada por padrão, sem payloads pré-definidos).
- Checklist de diagnóstico + registro do técnico (identificação, patrimônio, local etc.).
- Inventário de dispositivos (cadastro manual, IndexedDB).
- Histórico de diagnósticos com visualização, exportação e exclusão com confirmação.
- Exportação JSON (campos indisponíveis = `null`) e relatório legível em texto.
- Log técnico visual com copiar/limpar/exportar.
- **Dispositivos conhecidos** (`navigator.bluetooth.getDevices`): reconexão sem abrir o seletor e remoção de permissão (`device.forget`), quando o navegador oferece.
- **Varredura passiva experimental** (`navigator.bluetooth.requestLEScan`): anúncios em tempo real com RSSI/Tx Power/Manufacturer Data reais, quando o navegador oferece.
- **Descritores GATT** (dados avançados): listagem e leitura quando permitido pelo dispositivo.
- **Reconexão automática opcional** após queda de conexão (backoff 2s/5s/15s, até 3 tentativas, apenas dispositivos reais).
- **Leitura em lote** de todas as características READ de um serviço em um toque.
- **Acesso rápido a dispositivos conhecidos** direto da tela inicial.
- **Tela de compatibilidade**: matriz dos recursos BLE que este navegador realmente suporta.
- **Fallback automático**: "Iniciar busca" também ativa a varredura passiva quando o navegador a oferece.
- PWA: manifest, service worker, cache versionado, funcionamento offline da interface.
- Tema dark tecnológico + modo claro opcional. Mobile-first: bottom nav no celular, sidebar no desktop.
- Modo demonstração (dados identificados como **DEMO**, nunca misturados com dados reais).

## Requisitos

- Navegador com **Web Bluetooth API** (ex.: **Chrome para Android**; veja limitações abaixo).
- **HTTPS** (ou `localhost`) — a Web Bluetooth exige contexto seguro.
- Para varredura em Android, o sistema operacional pode exigir permissão de **Localização** (o app não usa nem armazena localização).
- Nenhum servidor, banco remoto ou credencial: tudo roda no navegador.

## Como executar

```bash
# opção 1 — servidor simples (localhost é contexto seguro):
python3 -m http.server 8000
# acesse http://localhost:8000

# opção 2 — qualquer hospedagem estática com HTTPS (GitHub Pages, Netlify etc.)
```

## Como testar BLE

1. Abra o app em um navegador compatível (ex.: Chrome para Android) via HTTPS.
2. Verifique no dashboard: *Web Bluetooth: Suportado* e *HTTPS: Seguro*.
3. Toque em **🔍 Procurar dispositivos BLE** — o navegador abrirá o seletor nativo.
4. Escolha o dispositivo autorizado, toque em **Conectar via GATT**.
5. Toque em **Descobrir serviços** e depois em **Ver características**.
6. Use **Ler** / **Ativar notificações** conforme as propriedades reais.
7. Preencha o diagnóstico e salve/exporte.

Para testar a interface sem hardware, ative o **Modo demonstração** em Configurações
(os dados aparecem marcados como **DEMO**).

## Como publicar no GitHub Pages

1. Crie um repositório e envie a pasta `ble-diagnostic/` para a branch `main`.
2. No GitHub: **Settings → Pages → Source: Deploy from a branch → `main` / root**.
3. Acesse `https://SEU-USUARIO.github.io/ble-diagnostic/` (HTTPS nativo, pronto para a Web Bluetooth).

## Como instalar como PWA

- **Android (Chrome):** menu → *Instalar aplicativo / Adicionar à tela inicial*.
- **Desktop (Chrome/Edge):** ícone de instalação na barra de endereço.
- Após instalado, a interface funciona offline (cache do Service Worker). O histórico local também permanece acessível offline; funções BLE informam a dependência de navegador/suporte quando indisponíveis.

## Compatibilidade

| Recurso | Observação |
|---|---|
| Web Bluetooth | Chrome/Edge (desktop e Android). **Não suportado** em iOS Safari e Firefox. O app detecta e informa. |
| `watchAdvertisements` (RSSI, Tx Power, Manufacturer Data) | Recurso experimental. Quando ausente, o app exibe "Não disponibilizado pelo sistema" — nada é inventado. |
| `getDevices` (dispositivos conhecidos) e `forget` | Chrome/Edge recentes. Quando ausentes, os botões não aparecem ou informam indisponibilidade. |
| `requestLEScan` (varredura passiva) | Experimental. O botão só aparece quando o navegador oferece; anúncios trazem RSSI real. |
| Descritores GATT (`getDescriptors`) | Experimental. Habilitar "Mostrar dados avançados" nas Configurações. |
| HTTPS | Obrigatório (exceto `localhost`). O app informa quando ausente. |
| IndexedDB, Service Worker, Clipboard | Navegadores modernos. Falhas são tratadas com mensagens amigáveis. |

## Limitações do Web Bluetooth

- **Não existe varredura passiva**: a "busca" é o seletor nativo (`requestDevice`), e o usuário escolhe o dispositivo.
- **RSSI e endereço MAC não são fornecidos** pelo seletor. O identificador exibido (`device.id`) é opaco e depende do navegador.
- **Serviços descobriveis são limitados** à lista `optionalServices` declarada. Configure seus UUIDs autorizados em *Configurações → Serviços autorizados conhecidos*.
- Uma página só mantém conexão enquanto estiver aberta; o sistema pode encerrar a conexão (o app escuta `gattserverdisconnected`).
- `watchAdvertisements` pode exigir flags experimentais dependendo da versão do navegador.

## Segurança

- Aviso permanente: *"Use este aplicativo somente em dispositivos BLE que você tenha autorização para diagnosticar."*
- CSP restritiva (sem scripts inline, sem recursos externos, `object-src 'none'`).
- Sanitização de todo conteúdo dinâmico exibido no DOM (`esc()`).
- Validação de entrada nos formulários e nos payloads HEX.
- Nenhuma credencial, chave secreta ou endpoint remoto no frontend.
- Nenhuma transmissão de dados sem consentimento (não existe envio a servidor).
- Confirmação obrigatória antes de excluir histórico/cadastros.
- WRITE desabilitado por padrão; ferramenta apenas genérica, sem comandos pré-definidos.

## Privacidade

- Dados ficam **localmente no dispositivo** por padrão (IndexedDB + localStorage de preferências).
- Nenhum dado é enviado para servidor sem implementação explícita.
- O aplicativo **não coleta dados bancários**, **não armazena senhas** e **não executa operações financeiras**.

## Arquitetura

```
/ble-diagnostic/
├── index.html               # app shell (SPA de seções)
├── manifest.webmanifest     # PWA
├── sw.js                    # service worker (cache versionado)
├── README.md
└── assets/
    ├── css/styles.css       # tema dark/light, mobile-first
    ├── icons/               # ícones PWA
    └── js/
        ├── app.js           # inicialização, roteamento, eventos
        ├── ble.js            # scanner, conexão, desconexão (Web Bluetooth)
        ├── gatt.js           # serviços, características, read, notify, write genérico
        ├── demo.js           # modo demonstração (separado, identificado como DEMO)
        ├── storage.js        # IndexedDB (inventário/histórico) + preferências
        ├── export.js         # JSON, relatório legível, downloads
        └── ui.js             # renderização, sanitização, toasts, modais, log
```

Camadas separadas por responsabilidade; a camada `ble.js`/`gatt.js` isola toda a API
do navegador, o que facilita portar a mesma lógica para outras plataformas.

## Como criar a versão Android nativa

A arquitetura já está preparada (toda a lógica de diagnóstico em módulos puros).
Na versão nativa, substitua a camada de comunicação pelas APIs do Android:

- **Scanner:** `BluetoothLeScanner` + `ScanCallback` (permissões modernas:
  `BLUETOOTH_SCAN` / `BLUETOOTH_CONNECT` no Android 12+, `ACCESS_FINE_LOCATION`
  quando exigido; no Android ≤11, `ACCESS_FINE_LOCATION` para varredura).
- **Conexão/GATT:** `BluetoothGatt` + `BluetoothGattCallback`
  (`onConnectionStateChange`, `onServicesDiscovered`, `onCharacteristicRead`,
  `onCharacteristicChanged`).
- **READ/NOTIFY:** `readCharacteristic()` e `setCharacteristicNotification()` com
  descritor CCCD (0x2902).
- **Persistência/exportação:** reaproveitar o mesmo modelo de dados
  (`storage.js`/`export.js` podem guiar o esquema Room ou DataStore).

**Regras mantidas na versão Android:** respeitar permissões modernas do Android,
não criar comandos específicos de ATM e nenhuma função financeira/mecânica. As
funcionalidades Android serão apenas: scanner BLE, conexão GATT, descoberta de
serviços, características, READ, NOTIFY, diagnóstico e exportação.

## Wi-Fi: por que não há conexão automática nesta PWA

Navegadores **não expõem API alguma** para detectar redes Wi-Fi (nem SSID, nem sinal) nem para conectar. Portanto:

- A PWA não detecta redes e não conecta automaticamente — e **não simula** isso.
- A tela **Compatibilidade** marca o recurso como "não suportado" em qualquer navegador.
- Conectar "sem senha" só é possível em **redes abertas**; redes WPA/WPA2/WPA3 exigem a credencial por protocolo.

### Especificação para a versão nativa Android (Kotlin)

| Etapa | API nativa | Observações |
|---|---|---|
| Detecção de redes | `WifiManager.startScan()` + `getScanResults()` | Requer `ACCESS_FINE_LOCATION`; Android limita a frequência de scans (throttling). |
| Conexão automática (Android 10+) | `WifiNetworkSuggestionManager` | O técnico aprova a sugestão uma vez; o sistema conecta automaticamente nas ocorrências seguintes. |
| Conexão sob demanda (Android 10+) | `WifiNetworkSpecifier` | Diálogo nativo; conecta à rede local, sem internet geral. |
| Rede aberta (sem senha) | Sugestão de rede `open` | Único caso possível sem credenciais. |
| WPA/WPA2/WPA3 | Credenciais informadas pelo técnico e salvas criptografadas | Não existe conexão sem a chave — é exigência do protocolo, não do app. |

Restrições inerentes: o Android exige consentimento do usuário (não há conexão invisível a redes novas) e redes protegidas nunca conectam sem credenciais, exceto quando já salvas no sistema.

## Autenticação e bloqueio de acesso

**Esta PWA não tem autenticação de servidor — e isso é dito com todas as letras.** A hospedagem (GitHub Pages) é estática, sem backend: qualquer "login" validado apenas no navegador é trivialmente contornável, e o projeto não mantém chaves secretas no frontend. Autenticação real (OAuth 2.0/OIDC, contas de usuário) pertence ao backend ou à versão nativa Android.

O que existe desde a v1.3.0 é o **bloqueio local de acesso por PIN** (módulo `auth.js`):

- PIN de 4–8 dígitos exigido ao abrir o aplicativo no dispositivo;
- Armazenado apenas localmente (localStorage) como **hash PBKDF2-SHA256 com salt aleatório, 150.000 iterações** (Web Crypto) — o PIN nunca é gravado em texto puro e não vai a logs;
- Navegação bloqueada até desbloquear; 5 tentativas incorretas ⇒ pausa de 30 s;
- Alteração exige o PIN atual; remoção exige confirmação explícita;
- Sem Crypto API (contexto não seguro): o bloqueio informa indisponibilidade — nunca simula.

O que este bloqueio **não** é:
- Não criptografa o histórico (IndexedDB continua legível no dispositivo);
- Não protege contra alguém com acesso técnico ao aparelho (devtools);
- Não substitui autenticação de servidor em cenário algum.

## Testes

Testes unitários sem frameworks (runner nativo do Node, zero dependências):

```bash
node --test tests/*.test.mjs
```

- `tests/auth.test.mjs` — fluxo completo do bloqueio local por PIN: validação (4–8 dígitos), registro PBKDF2 (salt + 150.000 iterações, PIN nunca em texto puro), verificação correta/incorreta, substituição, remoção, robustez contra dados corrompidos/adulterados no localStorage e aleatoriedade de salt.
- Requer Node 18+ (usa `node:test` e a Web Crypto embutida). O `localStorage` é simulado em memória — nada é gravado em disco.

## Versão

1.3.0
