mod json_decoder;
mod protocol;

#[cfg(not(target_os = "windows"))]
mod non_windows;
#[cfg(target_os = "windows")]
mod windows;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    #[cfg(target_os = "windows")]
    {
        return windows::run().await;
    }

    #[cfg(not(target_os = "windows"))]
    {
        return non_windows::run().await;
    }
}
