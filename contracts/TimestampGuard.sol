// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice A stateless bundle guard that makes execution before a Unix second invalid.
contract TimestampGuard {
    error TooEarly(uint256 currentTimestamp, uint256 notBeforeTimestamp);

    function requireTimestamp(uint256 notBeforeTimestamp) external view {
        if (block.timestamp < notBeforeTimestamp) {
            revert TooEarly(block.timestamp, notBeforeTimestamp);
        }
    }
}
