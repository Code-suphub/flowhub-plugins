//! Whole-machine counters, sampled with the existing background snapshot.
use serde_json::{json, Value};
use std::mem::{size_of, zeroed};

extern "C" {
    fn mach_port_deallocate(task: libc::mach_port_t, name: libc::mach_port_t) -> libc::kern_return_t;
}

#[derive(Default)]
pub struct Sampler {
    previous_cpu: Option<[u32; 4]>,
}

// Anonymous resident pages exclude file cache; purgeable pages are reclaimable.
// Count the compressor's physical pages, never its uncompressed logical size.
fn used_memory(internal: u64, purgeable: u64, wired: u64, compressed: u64, page_size: u64, total: u64) -> Option<u64> {
    if page_size == 0 || total == 0 { return None; }
    internal.saturating_sub(purgeable).checked_add(wired)?
        .checked_add(compressed)?.checked_mul(page_size).map(|v| v.min(total))
}

fn cpu_percent(previous: [u32; 4], current: [u32; 4]) -> Option<f64> {
    let delta = std::array::from_fn::<_, 4, _>(|i| u64::from(current[i].wrapping_sub(previous[i])));
    let total: u64 = delta.iter().sum();
    (total > 0).then(|| (total - delta[libc::CPU_STATE_IDLE as usize]) as f64 / total as f64 * 100.)
}

impl Sampler {
    #[allow(deprecated)] // Keep the existing libc Mach bindings; no extra runtime dependency.
    pub fn sample(&mut self) -> Value {
        let mut result = crate::native::system();
        let host = unsafe { libc::mach_host_self() };
        let mut vm: libc::vm_statistics64 = unsafe { zeroed() };
        let mut count = libc::HOST_VM_INFO64_COUNT;
        let memory = unsafe { libc::host_statistics64(host, libc::HOST_VM_INFO64, (&mut vm as *mut libc::vm_statistics64).cast(), &mut count) };
        let page_size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        // Older kernels return only their supported prefix of the newer libc struct.
        let required = (std::mem::offset_of!(libc::vm_statistics64, internal_page_count) + size_of::<u32>()) / size_of::<libc::integer_t>();
        let used = if memory == libc::KERN_SUCCESS && count as usize >= required && page_size > 0 {
            result["totalMemory"].as_u64().and_then(|total| used_memory(vm.internal_page_count.into(), vm.purgeable_count.into(), vm.wire_count.into(), vm.compressor_page_count.into(), page_size as u64, total))
        } else { None };
        let mut cpu: libc::host_cpu_load_info = unsafe { zeroed() };
        let mut count = libc::HOST_CPU_LOAD_INFO_COUNT;
        let ok = unsafe { libc::host_statistics(host, libc::HOST_CPU_LOAD_INFO, (&mut cpu as *mut libc::host_cpu_load_info).cast(), &mut count) };
        let ticks = (ok == libc::KERN_SUCCESS && count == libc::HOST_CPU_LOAD_INFO_COUNT).then_some(cpu.cpu_ticks);
        let usage = self.previous_cpu.zip(ticks).and_then(|(previous, current)| cpu_percent(previous, current));
        self.previous_cpu = ticks;
        // mach_host_self acquires a send right on every call.
        unsafe { mach_port_deallocate(libc::mach_task_self(), host); }
        result["usedMemory"] = json!(used);
        result["cpuUsage"] = json!(usage);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn memory_excludes_purgeable_and_counts_physical_compressor_pages() {
        assert_eq!(used_memory(100, 20, 30, 10, 16384, 1 << 30), Some(120 * 16384));
        assert_eq!(used_memory(100, 20, 30, 10, 4096, 1 << 30), Some(120 * 4096));
    }
    #[test]
    fn memory_bounds_invalid_or_racing_counters() {
        assert_eq!(used_memory(10, 20, 30, 10, 4096, 10000), Some(10000));
        assert_eq!(used_memory(u64::MAX, 0, 1, 0, 4096, u64::MAX), None);
        assert_eq!(used_memory(10, 0, 0, 0, 0, 1024), None);
        assert_eq!(used_memory(10, 0, 0, 0, 4096, 0), None);
    }
    #[test]
    fn cpu_uses_all_machine_ticks_including_nice_and_excludes_idle() {
        assert_eq!(cpu_percent([10, 10, 10, 10], [30, 20, 70, 20]), Some(40.));
        assert_eq!(cpu_percent([0; 4], [100, 100, 0, 100]), Some(100.));
        assert_eq!(cpu_percent([0; 4], [0, 0, 100, 0]), Some(0.));
        assert_eq!(cpu_percent([1; 4], [1; 4]), None);
    }
    #[test]
    fn cpu_handles_counter_wrap() {
        assert_eq!(cpu_percent([u32::MAX - 9, 0, u32::MAX - 9, 0], [10, 0, 10, 0]), Some(50.));
    }
    #[test]
    fn native_sample_has_memory_and_cpu_after_two_samples() {
        let mut sampler = Sampler::default();
        let first = sampler.sample();
        assert!(first["cpuUsage"].is_null());
        let total = first["totalMemory"].as_u64().unwrap();
        let used = first["usedMemory"].as_u64().unwrap();
        assert!(used > 0 && used <= total);
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!((0. ..=100.).contains(&sampler.sample()["cpuUsage"].as_f64().unwrap()));
    }
}
