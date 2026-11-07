//! The hand-off to the app window. A request gets a number and is sent out (the desktop emits an event to
//! its window); the window answers with that number and the reply is delivered to the waiting request.
//! A request nobody answers is forgotten when it times out, so nothing piles up.

use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};

use tokio::sync::oneshot;

use crate::{Forward, ForwardRequest, ForwardResponse};

type Emit = dyn Fn(u64, &ForwardRequest) + Send + Sync;

pub struct ChannelForward {
    next: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<ForwardResponse>>>,
    emit: Box<Emit>,
}

impl ChannelForward {
    pub fn new(emit: impl Fn(u64, &ForwardRequest) + Send + Sync + 'static) -> Arc<Self> {
        Arc::new(Self {
            next: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            emit: Box::new(emit),
        })
    }

    /// Deliver the window's answer. False when nobody is waiting for it any more (it timed out, or the id is wrong).
    pub fn reply(&self, id: u64, response: ForwardResponse) -> bool {
        match self.pending.lock().unwrap().remove(&id) {
            Some(tx) => tx.send(response).is_ok(),
            None => false,
        }
    }

    /// How many requests are waiting for an answer.
    pub fn waiting(&self) -> usize {
        self.pending.lock().unwrap().len()
    }
}

/// Removes the request from the table however the wait ends.
struct Waiting<'a> {
    owner: &'a ChannelForward,
    id: u64,
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        self.owner.pending.lock().unwrap().remove(&self.id);
    }
}

impl Forward for Arc<ChannelForward> {
    fn call(&self, req: ForwardRequest) -> Pin<Box<dyn Future<Output = ForwardResponse> + Send>> {
        let me = Arc::clone(self);
        Box::pin(async move {
            let id = me.next.fetch_add(1, Ordering::Relaxed);
            let (tx, rx) = oneshot::channel();
            me.pending.lock().unwrap().insert(id, tx);
            let _guard = Waiting { owner: &me, id };
            (me.emit)(id, &req);
            match rx.await {
                Ok(r) => r,
                Err(_) => ForwardResponse {
                    status: 503,
                    body: r#"{"ok":false,"error":{"code":"app_gone","message":"The app did not answer."}}"#.into(),
                },
            }
        })
    }
}
