//! gRPC mayastor proxy implementation
//!
//! It is a kind of proxy. Input request is gRPC, which is translated to
//! JSON-RPC understood by mayastor (SPDK). The return value goes through the
//! same transformation in opposite direction. The only exception is mounting
//! of volumes, which is actually done here in the proxy rather than in
//! mayastor. We aim for 1:1 mapping between the two RPCs.

#[macro_use]
extern crate clap;
#[macro_use]
extern crate log;
#[macro_use]
extern crate run_script;

use std::{
    fs,
    io::{ErrorKind, Write},
};

use chrono::Local;
use clap::{App, Arg};
use csi::{identity_server::IdentityServer, node_server::NodeServer};
use env_logger::{Builder, Env};
use futures::stream::TryStreamExt;
use std::{
    path::Path,
    pin::Pin,
    task::{Context, Poll},
};
use tokio::{net::UnixListener, prelude::*};
use tonic::transport::{server::Connected, Server};

use git_version::git_version;
// These libs are needed for gRPC generated code
use rpc::{self, service::mayastor_server::MayastorServer};

use crate::{
    identity::Identity,
    mayastor_svc::MayastorService,
    mount::probe_filesystems,
    node::Node,
};

#[allow(dead_code)]
#[allow(clippy::type_complexity)]
#[allow(clippy::unit_arg)]
#[allow(clippy::redundant_closure)]
#[allow(clippy::enum_variant_names)]
pub mod csi {
    tonic::include_proto!("csi.v1");
}

mod format;
mod identity;
mod mayastor_svc;
mod mount;
mod node;

#[derive(Debug)]
struct UnixStream(tokio::net::UnixStream);

impl Connected for UnixStream {}

impl AsyncRead for UnixStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut [u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.0).poll_read(cx, buf)
    }
}

impl AsyncWrite for UnixStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.0).poll_write(cx, buf)
    }

    fn poll_flush(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.0).poll_flush(cx)
    }

    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.0).poll_shutdown(cx)
    }
}

#[tokio::main]
async fn main() -> Result<(), String> {
    let matches = App::new("Mayastor agent")
        .version(git_version!())
        .about("k8s sidecar for Mayastor implementing CSI among others")
        .arg(
            Arg::with_name("address")
                .short("a")
                .long("address")
                .value_name("IP")
                .help("IP address of the k8s pod where this app is running")
                .required(true)
                .takes_value(true),
        )
        .arg(
            Arg::with_name("port")
                .short("p")
                .long("port")
                .value_name("NUMBER")
                .help("Port number to listen on for egress svc (default 10124)")
                .takes_value(true),
        )
        .arg(
            Arg::with_name("mayastor-socket")
                .short("s")
                .long("mayastor-socket")
                .value_name("PATH")
                .help("Socket path to mayastor backend (default /var/tmp/mayastor.sock)")
                .takes_value(true),
        )
        .arg(
            Arg::with_name("csi-socket")
                .short("c")
                .long("csi-socket")
                .value_name("PATH")
                .help("CSI gRPC listen socket (default /var/tmp/csi.sock)")
                .takes_value(true),
        )
        .arg(
            Arg::with_name("log-debug")
                .short("l")
                .help("Log extra info - file name and line number"),
        )
        .arg(
            Arg::with_name("node-name")
                .short("n")
                .long("node-name")
                .value_name("NAME")
                .help("Unique node name where this instance runs")
                .required(true)
                .takes_value(true),
        )
        .arg(
            Arg::with_name("v")
                .short("v")
                .multiple(true)
                .help("Sets the verbosity level"),
        )
        .get_matches();

    let node_name = matches.value_of("node-name").unwrap();
    let port = value_t!(matches.value_of("port"), u16).unwrap_or(10124);
    let addr = matches.value_of("address").unwrap();
    let ms_socket = matches
        .value_of("mayastor-socket")
        .unwrap_or("/var/tmp/mayastor.sock");
    let csi_socket = matches
        .value_of("csi-socket")
        .unwrap_or("/var/tmp/csi.sock");
    let level = match matches.occurrences_of("v") as usize {
        0 => "info",
        1 => "debug",
        _ => "trace",
    };

    // configure logger: env var takes precedence over cmd line options
    let filter_expr = format!("{}={}", module_path!(), level);
    let mut builder =
        Builder::from_env(Env::default().default_filter_or(filter_expr));
    if matches.is_present("log-debug") {
        builder.format(|buf, record| {
            let mut level_style = buf.default_level_style(record.level());
            level_style.set_intense(true);
            writeln!(
                buf,
                "[{} {} {}:{}] {}",
                Local::now().format("%Y-%m-%dT%H:%M:%SZ"),
                level_style.value(record.level()),
                Path::new(record.file().unwrap())
                    .file_name()
                    .unwrap()
                    .to_str()
                    .unwrap(),
                record.line().unwrap(),
                record.args()
            )
        });
    }
    builder.init();

    let saddr = format!("{}:{}", addr, port).parse().unwrap();
    info!("Agent starting service on {}", saddr);

    let tcp = Server::builder()
        .add_service(MayastorServer::new(MayastorService {
            socket: ms_socket.into(),
        }))
        .serve(saddr);

    // Remove stale CSI socket from previous instance if there is any
    match fs::remove_file(csi_socket) {
        Ok(_) => info!("Removed stale CSI socket {}", csi_socket),
        Err(err) => {
            if err.kind() != ErrorKind::NotFound {
                return Err(format!(
                    "Error removing stale CSI socket {}: {}",
                    csi_socket, err
                ));
            }
        }
    }

    let mut uds_sock = UnixListener::bind(csi_socket).unwrap();
    info!("Agent bound to CSI at {}", csi_socket);

    let uds = Server::builder()
        .add_service(NodeServer::new(Node {
            node_name: node_name.into(),
            addr: addr.to_string(),
            port,
            socket: ms_socket.into(),
            filesystems: probe_filesystems().unwrap(),
        }))
        .add_service(IdentityServer::new(Identity {
            socket: ms_socket.into(),
        }))
        .serve_with_incoming(uds_sock.incoming().map_ok(UnixStream));
    let _ = futures::future::join(uds, tcp).await;
    Ok(())
}
