//! UI preferences belong to the application data directory, not an ephemeral HTTP port.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Theme { Light, Dark }

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Language { System, Zh, En, Ja, Ko, Es, Pt, Ru, Fr }

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Preferences {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub theme: Option<Theme>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<Language>,
}

pub struct PreferenceStore { path: PathBuf, lock: Mutex<()> }

impl PreferenceStore {
    pub fn new(data: &Path) -> Self {
        Self { path: data.join("ui-preferences.json"), lock: Mutex::new(()) }
    }

    fn load(&self) -> Preferences {
        std::fs::read(&self.path).ok().filter(|bytes| bytes.len() <= 2048)
            .and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default()
    }

    fn get(&self) -> Result<Preferences, String> {
        let _guard = self.lock.lock().map_err(|_| "preferences_lock_failed")?;
        Ok(self.load())
    }

    fn set(&self, patch: Preferences) -> Result<Preferences, String> {
        let _guard = self.lock.lock().map_err(|_| "preferences_lock_failed")?;
        let mut current = self.load();
        if patch.theme.is_some() { current.theme = patch.theme; }
        if patch.language.is_some() { current.language = patch.language; }
        let bytes = serde_json::to_vec(&current).map_err(|_| "preferences_encode_failed")?;
        let temporary = self.path.with_extension("json.tmp");
        let save = || -> std::io::Result<()> {
            use std::io::Write;
            std::fs::create_dir_all(self.path.parent().ok_or_else(|| std::io::Error::other("missing directory"))?)?;
            let mut file = std::fs::File::create(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            std::fs::rename(&temporary, &self.path)
        };
        if save().is_err() {
            let _ = std::fs::remove_file(&temporary);
            return Err("preferences_save_failed".into());
        }
        Ok(current)
    }
}

#[tauri::command]
pub fn get_cclip_preferences(store: tauri::State<'_, PreferenceStore>) -> Result<Preferences, String> { store.get() }

#[tauri::command]
pub fn set_cclip_preferences(store: tauri::State<'_, PreferenceStore>, preferences: Preferences) -> Result<Preferences, String> { store.set(preferences) }

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static SEQUENCE: AtomicUsize = AtomicUsize::new(0);

    fn directory() -> PathBuf {
        let path = std::env::temp_dir().join(format!("cclip-preferences-{}-{}", std::process::id(), SEQUENCE.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn persists_partial_updates_across_instances_without_losing_other_settings() {
        let dir = directory();
        let store = PreferenceStore::new(&dir);
        store.set(Preferences { theme: Some(Theme::Light), ..Preferences::default() }).unwrap();
        for language in [Language::System, Language::Zh, Language::En, Language::Ja, Language::Ko, Language::Es, Language::Pt, Language::Ru, Language::Fr] {
            store.set(Preferences { language: Some(language.clone()), ..Preferences::default() }).unwrap();
            assert_eq!(PreferenceStore::new(&dir).get().unwrap(), Preferences { theme: Some(Theme::Light), language: Some(language) });
        }
        assert!(!store.path.with_extension("json.tmp").exists());
        std::fs::remove_file(store.path).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }

    #[test]
    fn validates_values_and_handles_corrupt_or_unwritable_storage() {
        for input in [r#"{"language":"unknown"}"#, r#"{"theme":"system"}"#, r#"{"apiKey":"never-store-arbitrary-fields"}"#] {
            assert!(serde_json::from_str::<Preferences>(input).is_err());
        }
        let dir = directory();
        let store = PreferenceStore::new(&dir);
        std::fs::write(&store.path, b"incomplete JSON").unwrap();
        assert_eq!(store.get().unwrap(), Preferences::default());
        std::fs::remove_file(&store.path).unwrap();
        std::fs::write(store.path.with_extension("json.tmp"), b"stale write").unwrap();
        store.set(Preferences { theme: Some(Theme::Dark), ..Preferences::default() }).unwrap();
        let impossible = PreferenceStore::new(&store.path); // The parent is a file.
        assert_eq!(impossible.set(Preferences::default()), Err("preferences_save_failed".into()));
        assert_eq!(store.get().unwrap().theme, Some(Theme::Dark));
        std::fs::remove_file(store.path).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
}
