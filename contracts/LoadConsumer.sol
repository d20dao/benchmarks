// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {D20VRFConsumer} from "@d20dao/vrf-sdk/contracts/D20VRFConsumer.sol";
import {ID20VRF} from "@d20dao/vrf-sdk/contracts/interfaces/ID20VRF.sol";

/// @title LoadConsumer
/// @notice Benchmark tool for the D20DAO VRF coordinator. One call opens `count` paid raw-randomness requests,
///         so a single sender can create concurrent load despite per-sender mempool limits. Every authenticated
///         callback is recorded with the block that delivered it. Not an application template.
contract LoadConsumer is D20VRFConsumer {
    /// @notice Upper bound per call; about 220,000 gas per request keeps 100 requests under a 30M block gas limit.
    uint256 public constant MAX_REQUESTS_PER_CALL = 100;

    address public immutable owner;
    uint256 public requested;
    uint256 public delivered;
    uint256 public refundNotifications;

    /// @notice True for every request ID opened by this contract.
    mapping(uint256 requestId => bool) public opened;
    /// @notice Block number of the authenticated callback for a request, 0 while undelivered.
    mapping(uint256 requestId => uint256) public deliveredBlock;

    event LoadOpened(bytes32 indexed runTag, uint256 firstRequestId, uint256 count, uint256 feeEach, uint32 callbackGasLimit);

    error NotOwner();
    error InvalidCount(uint256 count);
    error Underpaid(uint256 required, uint256 sent);
    error UnknownRequest(uint256 requestId);
    error DuplicateCallback(uint256 requestId);
    error ChangeFailed();

    constructor(address coordinator) D20VRFConsumer(coordinator) {
        owner = msg.sender;
    }

    /// @notice Opens `count` requests paying the exact in-transaction quote each and returns the unused value.
    /// @dev The owner is the refund address, so an expiry refund goes back to the benchmark wallet.
    function open(uint256 count, uint32 callbackGasLimit, bytes32 runTag) external payable returns (uint256 firstRequestId) {
        if (msg.sender != owner) revert NotOwner();
        if (count == 0 || count > MAX_REQUESTS_PER_CALL) revert InvalidCount(count);
        ID20VRF rng = ID20VRF(vrfCoordinator);
        uint256 fee = rng.quoteFee(callbackGasLimit);
        uint256 total = fee * count;
        if (msg.value < total) revert Underpaid(total, msg.value);
        uint256 sequence = requested;
        for (uint256 i; i < count; ++i) {
            uint256 id = rng.requestRandomness{value: fee}(keccak256(abi.encode(runTag, sequence + i)), callbackGasLimit, owner);
            opened[id] = true;
            if (i == 0) firstRequestId = id;
        }
        requested = sequence + count;
        emit LoadOpened(runTag, firstRequestId, count, fee, callbackGasLimit);
        if (msg.value > total) {
            (bool ok,) = payable(owner).call{value: msg.value - total}("");
            if (!ok) revert ChangeFailed();
        }
    }

    function _fulfillRandomness(uint256 requestId, bytes32) internal override {
        if (!opened[requestId]) revert UnknownRequest(requestId);
        if (deliveredBlock[requestId] != 0) revert DuplicateCallback(requestId);
        deliveredBlock[requestId] = block.number;
        ++delivered;
    }

    function _onRefund(uint256) internal override {
        ++refundNotifications;
    }
}
