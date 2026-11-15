# アップロード画像のライブラリ登録

ジョブのアップロード画像を、画像ライブラリへ審査待ちとして登録する。自動承認と元画像の削除は行わない。

## 既存構造への対応

- 候補画像: `generated/review/<asset_id>.<ext>`
- metadata: `metadata/review/<asset_id>.json`
- 重複キー: `file.sha256`
- 保存ファイル名・場所: `file.relative_path`
- 元ファイル名: `content.description`と`content.keywords`
- 登録日時: `generation.created_at`、`lifecycle.updated_at`
- 使用回数・最終使用: `usage.reuse_count`、`usage.last_used_at`
- 関連タイトル・タグ: `content.title`、`content.tags`、`content.keywords`
- 有効状態: `search.enabled`、`quality.status`、`lifecycle.state`

新規手動画像は`quality.status=pending`、`search.enabled=false`、`lifecycle.state=review`で保存し、人の承認前に自動検索へ出さない。job画像には任意互換フィールド`library_asset_id`を保存する。

## 重複と原本保護

全metadataをSHA-256で確認し、同一ハッシュが1件あれば画像をコピーせず、そのassetの利用回数、最終使用日時、最近のjob IDだけを更新する。同一ハッシュmetadataが複数ある場合は破損の可能性として停止する。

新規登録は`copyFile`の非上書きモードを使い、`manual_jobs/<job>/uploads`の原本を移動・削除しない。ライブラリmetadataとjob参照のどちらかの確定に失敗した場合は、新規候補を除去するか既存metadataを変更前へ戻す。

## 権利情報

既存Schemaは権利種別、ライセンス、商用利用、帰属表示条件を必須とする。推測で`owned`や商用利用可にしないため、登録呼出元はこれらを明示しなければならない。明示後も人のレビューが完了するまで検索は無効とする。
