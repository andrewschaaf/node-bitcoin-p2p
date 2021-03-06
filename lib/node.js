var sys = require('sys');
var logger = require('./logger'); // logging

var Peer = require('./peer').Peer;
var Settings = require('./settings').Settings;
var Storage = require('./storage').Storage;
var Connection = require('./connection').Connection;
var BlockChain = require('./blockchain').BlockChain;
var Accounting = require('./accounting').Accounting;
var PeerManager = require('./peermanager').PeerManager;
var Util = require('./util');

var Node = function (cfg) {
	events.EventEmitter.call(this);

	if (!cfg) cfg = new Settings();

	this.cfg = cfg;
	this.peers = [];
	this.connections = [];
	this.nonce = Util.generateNonce();
	this.version = 32001;

	this.state = null;
	this.running = false;

	this.storage = new Storage(this.cfg.storage.uri);
	this.blockChain = new BlockChain(this.storage);
	this.accounting = new Accounting(this.storage, this.blockChain);
	this.peerManager = new PeerManager(this);

	this.addListener('stateChange', this.handleStateChange.bind(this));
	this.setupStateTransitions();
};

sys.inherits(Node, events.EventEmitter);

/**
 * Setup triggers for automatically switching states.
 *
 * The Node class automatically switches to different state if a certain
 * event happens while it is in a certain state.
 *
 * During startup this is what causes the Node to progress through its
 * various startup stages.
 */
Node.prototype.setupStateTransitions = function ()
{
	var self = this;

	// When the BlockChain object has finished initializing,
	// start connecting to peers
	this.blockChain.addListener('initComplete', function () {
		if (self.state == 'init') self.setState('netConnect');
	});

	// When the first peer is fully connected, start the block
	// chain download
	this.peerManager.addListener('netConnected', function () {
		if (self.state == 'netConnect') self.setState('blockDownload');
	});
};

Node.prototype.start = function () {
	this.setState('init');
};

Node.prototype.setState = function (newState) {
	var oldState = this.state;

	// Don't allow switching to init state unless we are uninitialized
	if (newState == 'init' && oldState != null) return;

	this.state = newState;

	this.emit('stateChange', {oldState: oldState, newState: newState});
};

Node.prototype.handleStateChange = function (e) {
	// We consider the node to be "running" if it is in one of these states
	this.running = !!~['netConnect', 'blockDownload', 'default'].indexOf(e.newState);

	// Define what happens when we leave certain states
	switch (e.oldState) {}

	// Define what happens when we enter certain states
	switch (e.newState) {
	case 'init':
		this.blockChain.init();
		break;

	case 'netConnect':
		this.peerManager.enable();
		break;

	case 'blockDownload':
		this.startBlockChainDownload();
		break;
	}
};

Node.prototype.addPeer = function (peer) {
	this.peerManager.addPeer(peer);
};

Node.prototype.addConnection = function (conn) {
	conn.addListener('inv', this.handleInv.bind(this));
	conn.addListener('block', this.handleBlock.bind(this));
};

Node.prototype.getStorage = function () {
	return this.storage;
};

Node.prototype.getBlockChain = function () {
	return this.blockChain;
};

Node.prototype.getAccounting = function () {
	return this.accounting;
};

Node.prototype.startBlockChainDownload = function (toHash) {
	var genesisBlock = this.blockChain.getGenesisBlock();
	var topBlock = this.blockChain.getTopBlock();

	if (!toHash) toHash = new Buffer(32).clear();

	// TODO: Figure out a way to spread load across peers

	var starts = [];

	if (topBlock.hash.compare(genesisBlock.hash) != 0) {
		starts.push(topBlock.hash);
	}

	starts.push(genesisBlock.hash);

	var conn = this.peerManager.getActiveConnection();
	if (conn) {
		// Create some nicely formatted info about the chain height
		var heightInfo = '';
		if (topBlock.height < conn.bestHeight) {
			var curHeight = ""+topBlock.height;
			var maxHeight = ""+conn.bestHeight;
			while (curHeight.length < maxHeight.length) {
				curHeight = " "+curHeight;
			}
			heightInfo = ' '+curHeight+'/'+maxHeight;
		}
		logger.info('Downloading blocks'+heightInfo+
					 ' (current top: '+Util.formatHash(starts[0])+')');
		conn.sendGetBlocks(starts, toHash);
	} else {
		this.setState('netConnect');
	}
};

Node.prototype.handleInv = function (e) {
	var self = this;
	var invs = e.message.invs;
	var toCheck = invs.length;
	var unknownInvs = [];

	var topBlock = this.blockChain.getTopBlock();

	if (invs.length == 1 && invs[0].type == 2) {
		if (topBlock && topBlock.hash.compare(invs[0].hash) != 0) {
			self.startBlockChainDownload(invs[0].hash);
		}
	}

	// An inv with a single hash containing our most recent unconnected block is
	// a special inv, it's kind of like a tickle from the peer telling us that it's
	// time to download more blocks to catch up to the block chain. We could just
	// ignore this and treat it as a regular inv but then we'd download the head
    // block over and over again after each batch of 500 blocks, which is wasteful.
	/*if (invs.length == 1 && invs[0].type == 2 &&
		topBlock && topBlock.hash.compare(invs[0].hash) == 0) {
		this.startBlockChainDownload(invs[0].hash);
		return;
	}*/

	var lastBlock = null;
	for (var i = 0; i < invs.length; i++) {
		var method;
		switch (invs[i].type) {
		case 1: // Transaction
			method = 'knowsTransaction';
			break;
		case 2: // Block
			method = 'knowsBlock';
			lastBlock = i;
			break;
		default: // Unknown type
			continue;
		}

		// This will asynchronously check all the blocks and transactions. Finally,
		// the last callback will trigger the 'getdata' request.
		this.storage[method](invs[i].hash, (function (err, known) {
			toCheck--;

			if (err) {
				logger.error('Node.handleInv(): Could not check inv against storage',
							  invs[this]);
			} else {
				if (!known) unknownInvs.push(invs[this]);
				else {
					logger.info('Known inv: '+Util.formatHash(invs[this].hash));
				}
			}

			// This is the last block we'll request. When it comes back, we want to check
			// again if there is more to download still.
			// TODO: Do we need this or should we just rely on the "tickle inv"?
			/*if (lastBlock != null && this.index == (this.len - 1)) {
				e.conn.once('block', function () {

				});
			}*/

			if (toCheck == 0 && unknownInvs.length) {
				e.conn.sendGetData(unknownInvs);
			}
		}).bind(i));
	}
};

Node.prototype.handleBlock = function (e) {
	var txs = e.message.txs;
	var block = this.blockChain.makeBlockObject({
		"version": 1,
		"prev_hash": e.message.prev_hash,
		"merkle_root": e.message.merkle_root,
		"timestamp": e.message.timestamp,
		"bits": e.message.bits,
		"nonce": e.message.nonce
	});

	block.hash = block.calcHash();
	block.size = e.message.size;
	this.blockChain.add(block, txs, function (err, block) {
		if (err) {
			logger.error("Error while adding block to chain: "+err);
			return;
		}
		logger.bchdbg('Block added successfully ' + block);
	});
};

exports.Node = Node;
