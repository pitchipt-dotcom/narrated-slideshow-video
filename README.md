# narrated-slideshow-video

静止画と台本を渡すと、読み上げ音声と字幕が付き、台本の区切りに合わせて画像が切り替わる動画(MP4)を作る、自宅サーバー向けの小さな Web アプリです。

*Turns still images and a script into a narrated slideshow video with burned-in subtitles. A home-lab reference implementation, not a supported product.*

## これは何か

- スマホのブラウザ(ホーム画面に追加できる PWA)から「画像を選ぶ → 台本を貼る → 作る」の3操作で動画を作ります。
- 音声合成は [Irodori-TTS-Server](https://github.com/Aratako/Irodori-TTS-Server)、結合と字幕の焼き込みは FFmpeg を使います。
- バックエンドは Node.js の標準モジュールだけで書いてあり、npm の実行時依存はありません。

**自宅環境向けの実装例です。** 作者の環境で動いているものを切り出して公開しているだけで、動作保証もサポートもしません。Issue や Pull Request に対応できるとは限りません。

## 重要な前提(セキュリティ)

このアプリは **Tailscale Serve の背後で動かす前提** で作られています。

- API サーバーは `127.0.0.1` だけで待ち受け、Tailscale Serve が付ける `Tailscale-User-Login` ヘッダーを **そのまま信用して** 利用者を判定します。アプリ自身はパスワードもログイン画面も持ちません。
- そのため、このヘッダーを偽装できる経路(別のリバースプロキシ、ポートの直接公開、同じマシン上の信用できないプロセスなど)から届く状態にすると、誰でも操作できてしまいます。
- **インターネットへそのまま公開しないでください。** Tailscale Funnel、ポート開放、一般のリバースプロキシでの公開は想定していません。
- 更新系のリクエストは、`Origin` が `MANUAL_PUBLIC_ORIGIN` と一致し、`X-Requested-With: manual-video-ui` が付いている場合だけ受け付けます。

## 同梱していないもの

次のものはこのリポジトリに入っていません。各自で用意し、**ライセンスと利用条件を自分で確認してください。**

| もの | 用意のしかた | ライセンス(2026-11-16 に配布元で確認) |
|---|---|---|
| 音声合成サーバー | [Aratako/Irodori-TTS-Server](https://github.com/Aratako/Irodori-TTS-Server) を別途起動 | MIT |
| 音声合成モデル | [Aratako/Irodori-TTS-500M-v3](https://huggingface.co/Aratako/Irodori-TTS-500M-v3)(サーバーが取得) | MIT。モデルカードに倫理上の制限あり(下記) |
| 音声コーデック | [Aratako/Semantic-DACVAE-Japanese-32dim](https://huggingface.co/Aratako/Semantic-DACVAE-Japanese-32dim) | MIT |
| 参照音声(声の見本) | Irodori-TTS-Server の `voices/` に自分で置く | 自分で権利を確認 |
| 画像 | 自分でアップロードするか、画像ライブラリに登録 | 自分で権利を確認 |
| フォント | OS の Noto Sans CJK JP(Debian/Ubuntu なら `fonts-noto-cjk`) | SIL Open Font License 1.1 |
| FFmpeg | OS のパッケージ | ビルドにより LGPL または GPL |

Irodori-TTS のモデルカードは、ライセンス条項に加えて次を求めています。**本人の明示的な同意なく特定の人物の声を複製・なりすましに使わないこと、誤解を招く合成音声やディープフェイクを作らないこと。** 参照音声を使う場合は特に注意してください。上の表は確認した時点の内容です。使う前に配布元の最新の記載を確認してください。

## 処理の流れ

API サーバーがジョブを `job.json` として保存し、worker が5秒ごとに最も古い未完了ジョブを1段階ずつ進めます。

| 段階 | 状態 | 内容 | 主なファイル |
|---|---|---|---|
| 登録 | `queued` | 画像と台本を受け取りジョブを作る | `backend/manual-job-registration.js` |
| 台本分割 | `segments_ready` | 台本を `===SEGMENT===` 行、空行、句点の順で区切る | `backend/manual-script-segmentation.js` |
| 音声生成 | `audio_generating` → `audio_ready` | 区切りを約100文字のブロックにまとめて TTS へ送る | `backend/manual-segment-audio-generation.js` |
| 音声連結 | `audio_ready` | WAV を連結し、各区切りの開始・終了秒を実測から決める | `backend/manual-audio-assembly.js` |
| 字幕生成 | `subtitle_ready` | 1画面40文字・2行以内の SRT を作る | `backend/manual-subtitle-generation.js`、`backend/subtitle-layout.js` |
| 画像の時間割り | `images_ready` | 区切りの境界で画像を切り替える計画を作る | `backend/manual-image-timing.js` |
| 動画生成 | `video_ready` | FFmpeg で画像・音声・字幕を結合し、出力を検証する | `backend/manual-video-generation.js` |
| 保管 | `video_ready` | 成果物をチェックサム付きで別フォルダへコピーする | `backend/manual-artifact-archive.js` |

- 画像の切り替えは、画像の枚数が区切りの数以下なら区切りの境界で、多ければ全体の均等割りです。画像ごとの秒数を指定することもできます。
- 出力は 768×512(3:2)、30fps、H.264 / AAC の MP4 で、字幕は映像に焼き込みます。
- 一時的な失敗(TTS が落ちている、など)だけ、既定で3回まで自動で再試行します。

個別の設計メモは `docs/` にあります。

## 必要なもの

- Linux(systemd を使う場合)。作者の環境は Ubuntu です。
- Node.js 22 以上(22.22 で確認)
- FFmpeg と ffprobe(libass の `subtitles` フィルタと libx264 が有効なもの。8.0 で確認)
- Noto Sans CJK JP フォント
- Irodori-TTS-Server(OpenAI 互換の `/v1/audio/speech` と `/health`)。GPU を推奨します。作者の環境では VRAM を約4GB 使います。
- Tailscale(Serve で HTTPS と利用者の識別を行う)

## 起動方法

### 1. 設定ファイルを作る

```bash
cp config/manual-video.env.example config/manual-video.env
cp config/voice_profiles.example.json /srv/narrated-slideshow/config/voice_profiles.json
cp config/pronunciation-dictionary.example.json /srv/narrated-slideshow/config/pronunciation-dictionary.json
```

`config/manual-video.env` の主な項目です。保存先はすべて自分で決めて指定します(既定の保存先はありません)。

| 項目 | 内容 | 例 |
|---|---|---|
| `MANUAL_JOB_PORT` | API の待ち受けポート(`127.0.0.1` 固定) | `8021` |
| `MANUAL_JOBS_ROOT` | ジョブの保存先 | `/srv/narrated-slideshow/manual_jobs` |
| `MANUAL_JOBS_LOGICAL_ROOT` | `job.json` に書く論理パス(実パスを記録しないための名前) | `/data/slideshow/manual_jobs` |
| `MANUAL_IMAGE_LIBRARY_ROOT` | 画像ライブラリの場所 | `/srv/narrated-slideshow/images/library` |
| `MANUAL_IMAGE_LIBRARY_LOGICAL_ROOT` | 同、論理パス | `/data/slideshow/images/library` |
| `MANUAL_ALLOWED_TAILSCALE_USERS` | 使ってよい Tailscale ログイン名(カンマ区切り) | `you@example.com` |
| `MANUAL_PUBLIC_ORIGIN` | Tailscale Serve の URL | `https://your-host.your-tailnet.ts.net:8444` |
| `MANUAL_VOICE_PROFILES_PATH` | 声の設定ファイル | `/srv/narrated-slideshow/config/voice_profiles.json` |
| `MANUAL_PRONUNCIATION_DICTIONARY` | 読み辞書(画面から編集できる。例にはリハビリ分野の用語が9語入っています。不要なら `entries` を空にしてください) | `/srv/narrated-slideshow/config/pronunciation-dictionary.json` |
| `MANUAL_IRODORI_URL` | TTS サーバー | `http://127.0.0.1:8088` |
| `MANUAL_WORKER_RETRY_FAILED` / `MANUAL_WORKER_MAX_RETRIES` | 自動再試行 | `1` / `3` |
| `MANUAL_LOCAL_ARCHIVE_ROOT` | 完成物の保管先(任意) | `/srv/narrated-slideshow/manual_archive` |

声の設定(`voice_profiles.json`)の `voice` は、Irodori-TTS-Server の `voices/` に置いた参照音声のファイル名(拡張子なし)です。

### 2. 動かす

```bash
set -a; . config/manual-video.env; set +a
node backend/manual-job-server.js   # 画面と API
node backend/manual-job-worker.js   # ジョブを処理する側(別の端末で)
```

常駐させる場合は `systemd/` の user unit の例を、パスを書き換えて使ってください。

### 3. Tailscale Serve で tailnet 内に出す

```bash
tailscale serve --bg --https=8444 http://127.0.0.1:8021
```

スマホの Chrome で `MANUAL_PUBLIC_ORIGIN` の URL を開き、メニューから「ホーム画面に追加」を選ぶとアプリとして使えます。

### 画像ライブラリ(任意)

何度も使う画像は、`MANUAL_IMAGE_LIBRARY_ROOT` の下に画像と、`metadata/` 以下のどこかに画像ごとの JSON を置くと、画面のサムネイルから選べます。選べるのは、次の条件をすべて満たすものだけです。

```json
{
  "asset_id": "sample_asset_001",
  "file": { "relative_path": "assets/common/sample_asset_001.png", "sha256": "<64桁>", "mime_type": "image/png", "width": 1536, "height": 1024 },
  "content": { "title": "サンプル", "tags": [] },
  "quality": { "status": "approved" },
  "search": { "enabled": true },
  "rights": { "commercial_use": true },
  "lifecycle": { "state": "common" }
}
```

`/image-library-admin` からアップロードと評価(採用・保留・除外)ができます。ただし、アップロードした画像は `lifecycle.state` が `review` のままなので、選べるようにするには JSON の `lifecycle.state` を `common` に直す必要があります(この昇格を行う道具は同梱していません)。

### TTS を必要なときだけ起動する(任意)

`MANUAL_IRODORI_AUTOSTART=1` にすると、worker が音声生成の直前に Irodori の systemd unit を起動し、未完了のジョブがなくなったら停止します。GPU を他の用途と共有している環境向けです。

- worker が自分で起動したものだけを止めます。手動で起動したものは止めません。
- sudo を使わずに起動・停止するため、`polkit/50-manual-video-irodori.rules` の `YOUR_USER` を書き換えて `/etc/polkit-1/rules.d/` に置きます。
- 起動するのは `nvidia-smi` に計算プロセスがないときだけです。
- `MANUAL_GPU_COORDINATOR_URL` を設定すると、そのサービスが空いているときだけ起動します。worker は `GET <URL>/api/resources` と `GET <URL>/api/gpu` を読み、前者の `mode` と `lifecycle` が `IDLE`、後者の `model_states` がすべて `STOPPED` であることなどを確認します(判定は `backend/manual-irodori-autostart.js` の `hostIsIdle`)。これは作者の環境にある別のサービスの形に合わせたもので、汎用の仕組みではありません。

## テスト

```bash
npm install     # 画面のテストが使う jsdom(開発用)だけが入ります
npm test
```

- `tests/test_*.js` を1本ずつ実行します。個別に `node tests/test_manual_image_timing.js` のようにも実行できます。
- 音声連結・動画生成・画像アップロードのテストは、実際に `ffmpeg` / `ffprobe` を呼びます。
- TTS サーバーと GPU は使いません(音声は差し替えています)。

## 制限

- 出力は 768×512(3:2)固定です。ほかの縦横比はコードに定義がありますが、画面から選ぶ入口はありません。
- 字幕の書式(フォント、大きさ、位置)は `backend/manual-video-generation.js` に固定で書いてあります。
- 画像は1ジョブ20枚まで、1枚20MB まで。台本は20,000文字までです。
- 利用者は1人〜数人を想定しています。ジョブは1つずつ順番に処理します。
- 画面とメッセージは日本語だけです。
- ジョブの状態はファイル(`job.json`)で管理しており、データベースは使いません。

## ライセンス

[MIT](LICENSE)。同梱していないソフトウェア・モデル・素材には、それぞれのライセンスが適用されます。
