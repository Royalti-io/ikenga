//! Concrete `Registry` implementations. Add one module per registry; expose
//! the `*Registry` struct and (optionally) lookup APIs other code needs.

pub mod cron;
pub mod engine_assets;
pub mod iyke_routes;
pub mod mcp;
pub mod permissions;
pub mod queries;
pub mod settings;
pub mod sidecars;
pub mod ui_routes;

pub use cron::CronRegistry;
pub use engine_assets::EngineAssetsRegistry;
pub use iyke_routes::IykeRoutesRegistry;
pub use mcp::McpRegistry;
pub use permissions::PermissionsRegistry;
pub use queries::QueriesRegistry;
pub use settings::SettingsRegistry;
pub use sidecars::SidecarsRegistry;
pub use ui_routes::UiRoutesRegistry;
