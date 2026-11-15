# エラー処理と再試行

## 基本方針

workerは処理中に受け取った例外を必ずjobの`failed`と`error`へ保存する。`error`は発生工程、code、500文字以内の利用者向けmessage、再試行可否、任意のsegment IDだけを保持し、台本全文、HTTP応答本文、host path、秘密値は保存しない。

workerのstderrは日時、error code、短いmessageだけを出す。APIは日時、HTTP method、pathname、error name、code、status codeだけをJSON Linesで記録し、入力本文、query、header、stackは記録しない。

## 工程と再開位置

| error.stage | 対象 | 再開状態 |
|---|---|---|
| `segmenting` | 台本分割 | 自動再試行なし。入力修正後に新規登録 |
| `audio_generating` | Irodori segment音声 | `audio_generating`。Irodori停止時は`waiting_for_tts_service` |
| `audio_ready` | ffprobe、tempo、音声連結 | `audio_ready` |
| `subtitle_generating` | SRT生成 | `audio_ready` |
| `image_planning` | 画像順・表示時間 | `subtitle_ready` |
| `video_generating` | FFmpeg動画生成 | `images_ready` |
| `video_ready` | local/NAS archive | `video_ready` |

例外が`retryable: true`を明示した場合だけ自動再試行する。明示のない検証・パス・整合性エラーは非再試行とする。成功して1工程進んだ時点で連続失敗回数を0へ戻す。

`MANUAL_WORKER_MAX_RETRIES`へ達した失敗は`retryable: false`へ確定し、messageへ再試行上限到達を追記する。以後candidateから除外し、5秒pollで同じjobを繰り返さない。

## 二重実行と中間成果物

- job全体は`.manual-worker.lock`の排他的作成で1workerだけが処理する。
- 音声連結、字幕、動画は工程別lockも持つ。
- 出力は非上書きで作成し、job更新失敗時は今回作った中間出力だけを除去する。
- `job.json`とworker stateは一時ファイルからrenameして更新する。
- `video_ready`かつ`archive.status=local_only|nas_saved`は正常な処理済みjobとしてcandidateから除外する。
- NAS保存失敗はlocal bundleが確定していれば動画生成失敗にせず`local_only`とする。

## 利用者表示

status DTOは内部pathや台本を返さず、日本語の工程名、error code、短いmessage、再試行状態、次の操作だけを返す。台本構造エラーだけ「台本を修正して新しく登録」とし、その他の非再試行エラーは「管理者がエラー内容を確認」とする。local-onlyを含むarchive済みjobは次工程を表示しない。
