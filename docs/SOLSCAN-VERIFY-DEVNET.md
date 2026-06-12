# Solscan / Anchor — верификация на devnet

Program ID: `FZzo6eBAu9qzoNWNAHvw3qjgT6J89fZeAq9xUXjiyPed`

## Что реально можно на devnet

| Цель | Devnet | Комментарий |
|------|--------|-------------|
| В tx: **Program Logs** → `Instruction: RollKind` | ✅ уже есть | Не требует верификации |
| В tx: вкладка **Events** с `KindRolled` (kind, roll) | ⚠️ частично | Нужен **IDL on-chain** или whitelist Solscan |
| В **списке** программы колонка **Instructions** → `roll_kind` | ⚠️ частично | То же: IDL + иногда ручной whitelist Solscan |
| Бейдж **Program is verified** (исходники = hash on-chain) | ❌ обычно нет | Solana Explorer / Solscan **не показывают verified badge на devnet** ([issue](https://github.com/Ellipsis-Labs/solana-verifiable-build/issues/127)) |
| Полная **verified build** (GitHub ↔ `.so`) | ⚠️ upload есть, badge нет | `solana-verify` на devnet можно отработать перед mainnet |

**Итог:** на devnet имеет смысл **опубликовать IDL** и проверить, стал ли Solscan красивее парсить `roll_kind`. Полный «зелёный verified» — план на **mainnet**.

---

## Шаг 1 — IDL on-chain (главное для Solscan)

Нужен кошелёк **upgrade authority** программы `FZzo…` (тот, кто делал deploy/upgrade, не обязательно mint).

### WSL (рекомендуется)

```bash
cd /mnt/c/Users/Admin/Desktop/CryptoLottery_today/Cursor\ AI/crypto-lottery-today
solana config set --url devnet

# IDL из репо (после CI или anchor build)
test -f target/idl/gift_draw_registry.json

# Кошелёк authority программы:
export ANCHOR_WALLET=~/.config/solana/id.json   # или путь к вашему keypair

anchor idl init \
  --filepath target/idl/gift_draw_registry.json \
  FZzo6eBAu9qzoNWNAHvw3qjgT6J89fZeAq9xUXjiyPed \
  --provider.cluster devnet
```

Если IDL уже был инициализирован:

```bash
anchor idl upgrade \
  --filepath target/idl/gift_draw_registry.json \
  FZzo6eBAu9qzoNWNAHvw3qjgT6J89fZeAq9xUXjiyPed \
  --provider.cluster devnet
```

Стоимость: rent за IDL-аккаунт (порядка ~0.0x SOL), плюс комиссия tx.

### Проверка

1. [Solscan program (devnet)](https://solscan.io/account/FZzo6eBAu9qzoNWNAHvw3qjgT6J89fZeAq9xUXjiyPed?cluster=devnet) — ищите блок **IDL** / Anchor.
2. Новая tx `roll_kind` — откройте tx: инструкция не `# Unknown`, а **`roll_kind`** (если Solscan подхватил IDL).
3. Локально: `npm run decode-kind-rolled -- <ROLL_TX_SIG>` — как сейчас.

---

## Шаг 2 — Solscan whitelist (если после IDL всё ещё пусто)

По [документации Solscan](https://docs.solscan.io/integration/parse-instruction):

1. IDL on-chain (шаг 1).
2. Написать Solscan: program id `FZzo6eBA…`, devnet, ссылка на публичный GitHub `gift-draw-registry` / `programs/gift_draw_registry`.

Каналы: Twitter [@solscanofficial](https://twitter.com/solscanofficial) или их Discord.

---

## Шаг 3 — Verified build (репетиция перед mainnet)

Только если `.so` на chain **собран из известного commit** (CI artifact от того же `git sha`).

```bash
cargo install solana-verify
solana config set --url devnet

# Commit = тот, с которого CI собрал задеплоенный .so (например 37515e5)
export PROGRAM_ID=FZzo6eBAu9qzoNWNAHvw3qjgT6J89fZeAq9xUXjiyPed
export REPO=https://github.com/1fair-labs/gift-draw-today.git
export COMMIT=<GIT_SHA_CI_BUILD>

solana-verify verify-from-repo \
  -u https://api.devnet.solana.com \
  --program-id "$PROGRAM_ID" \
  "$REPO" \
  --commit-hash "$COMMIT" \
  --library-name gift_draw_registry \
  --mount-path programs/gift_draw_registry
```

Подписывает **upgrade authority**. На devnet badge в explorer может **не появиться** — это нормально. На mainnet после того же flow + `solana-verify remote submit-job` (см. [Solana verified builds](https://solana.com/docs/programs/verified-builds)).

**Важно:** CI сейчас: `anchor build --no-idl`. Для `solana-verify` нужен **verifiable** build (`anchor build --verifiable` или Docker-образ solana-verify) и **тот же commit**, иначе hash не совпадёт.

---

## Чеклист «проверили на devnet»

- [ ] `anchor idl init` / `upgrade` прошёл без ошибки
- [ ] На Solscan program page виден IDL (или Anchor-секция)
- [ ] Новая покупка → roll tx → в Solscan не только `Unknown`, есть `roll_kind` / `KindRolled`
- [ ] `npm run decode-kind-rolled` совпадает с типом в приложении

---

## Mainnet (позже)

1. Один deploy program id (новый или тот же — по продуктовому решению).
2. `anchor idl init` на mainnet.
3. `solana-verify verify-from-repo` + `remote submit-job` с upgrade authority.
4. Solscan whitelist при необходимости.

См. также: `docs/REGISTRY-DEPLOY-RUNBOOK.md`, `docs/on-chain-trust-model.md`.
