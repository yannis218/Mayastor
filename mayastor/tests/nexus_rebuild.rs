use crossbeam::channel::{after, select, unbounded};
use log::info;
use std::time::Duration;

pub mod common;

use mayastor::{
    bdev::{nexus_create, nexus_lookup},
    core::{mayastor_env_stop, MayastorCliArgs, MayastorEnvironment, Reactor},
};

use rpc::mayastor::ShareProtocolNexus;

static DISKNAME1: &str = "/tmp/disk1.img";
static BDEVNAME1: &str = "aio:///tmp/disk1.img?blk_size=512";

static DISKNAME2: &str = "/tmp/disk2.img";
static BDEVNAME2: &str = "aio:///tmp/disk2.img?blk_size=512";

static NEXUS_NAME: &str = "rebuild_test";
static NEXUS_SIZE: u64 = 10 * 1024 * 1024; // 10MiB

#[test]
fn rebuild_test() {
    common::delete_file(&[DISKNAME1.into(), DISKNAME2.into()]);
    common::truncate_file(DISKNAME1, NEXUS_SIZE / 1024);
    common::truncate_file(DISKNAME2, NEXUS_SIZE / 1024);

    test_init!();

    Reactor::block_on(rebuild_test_start());

    common::delete_file(&[DISKNAME1.into(), DISKNAME2.into()]);
}

async fn rebuild_test_start() {
    create_nexus().await;

    let nexus = nexus_lookup(NEXUS_NAME).unwrap();
    let device = nexus
        .share(ShareProtocolNexus::NexusNbd, None)
        .await
        .unwrap();

    let nexus_device = device.clone();
    let (s, r) = unbounded::<String>();
    std::thread::spawn(move || {
        s.send(common::dd_urandom_blkdev(&nexus_device))
    });
    reactor_poll!(r);

    let nexus_device = device.clone();
    let (s, r) = unbounded::<String>();
    std::thread::spawn(move || {
        s.send(common::compare_nexus_device(&nexus_device, DISKNAME1, true))
    });
    reactor_poll!(r);

    let nexus_device = device.clone();
    let (s, r) = unbounded::<String>();
    std::thread::spawn(move || {
        s.send(common::compare_nexus_device(
            &nexus_device,
            DISKNAME2,
            false,
        ))
    });
    reactor_poll!(r);

    // add the second child
    nexus.add_child(BDEVNAME2).await.unwrap();

    // kick's off the rebuild (NOWAIT) so we have to wait on a channel
    let rebuild_complete = nexus.start_rebuild(BDEVNAME2).await.unwrap();
    let (s, r) = unbounded::<()>();
    std::thread::spawn(move || {
        select! {
            recv(rebuild_complete) -> state => info!("rebuild of child {} finished with state {:?}", BDEVNAME2, state),
            recv(after(Duration::from_secs(5))) -> _ => panic!("timed out waiting for the rebuild to complete"),
        }
        s.send(())
    });
    reactor_poll!(r);

    let (s, r) = unbounded::<String>();
    std::thread::spawn(move || {
        s.send(common::compare_devices(DISKNAME1, DISKNAME2, true))
    });
    reactor_poll!(r);

    mayastor_env_stop(0);
}

async fn create_nexus() {
    let ch = vec![BDEVNAME1.to_string()];
    nexus_create(NEXUS_NAME, NEXUS_SIZE, None, &ch)
        .await
        .unwrap();
}
