use std::path::PathBuf;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenvy::dotenv().ok();
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let port = std::env::var("PORT")
        .unwrap_or_else(|_| "4173".into())
        .parse()?;
    // CUSTOMIZE_DATA picks another data folder (database, uploads). Default: ./data
    let data = std::env::var("CUSTOMIZE_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| root.join("data"));
    customize::run(root, data.join("shoppers.json"), port).await
}
